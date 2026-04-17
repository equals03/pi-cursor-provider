import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "vitest";
import {
  AgentClientMessageSchema,
  DeleteArgsSchema,
  ExecServerMessageSchema,
  FetchArgsSchema,
  GrepArgsSchema,
  LsArgsSchema,
  McpToolDefinitionSchema,
  ReadArgsSchema,
  ShellArgsSchema,
  WriteArgsSchema,
  type ExecClientMessage,
  type ExecServerMessage,
  type McpToolDefinition,
} from "./proto/agent_pb.ts";
import { redirectNativeExecToTool, sendPendingExecResult, type PendingExec } from "./native-tools.ts";

function mcpTool(name: string): McpToolDefinition {
  return create(McpToolDefinitionSchema, {
    name,
    toolName: name,
    description: "",
    providerIdentifier: "",
    inputSchema: new Uint8Array(),
  });
}

function execServer(
  execCase: NonNullable<ExecServerMessage["message"]>["case"],
  value: object,
  opts?: { id?: number; execId?: string },
): ExecServerMessage {
  return create(ExecServerMessageSchema, {
    id: opts?.id ?? 1,
    execId: opts?.execId ?? "exec-1",
    message: { case: execCase, value } as never,
  });
}

function decodeBridgePayloads(writes: Uint8Array[]) {
  return writes.map((buf) => {
    const payload = buf.subarray(5);
    return fromBinary(AgentClientMessageSchema, payload);
  });
}

function collectBridge(): { writes: Uint8Array[]; bridge: { write: (data: Uint8Array) => void } } {
  const writes: Uint8Array[] = [];
  return {
    writes,
    bridge: {
      write(data: Uint8Array) {
        writes.push(data);
      },
    },
  };
}

describe("redirectNativeExecToTool", () => {
  test("readArgs maps to first available candidate (prefers read over mcp_pi_read)", () => {
    const exec = execServer("readArgs", create(ReadArgsSchema, { path: "/foo/bar.ts", toolCallId: "tc-read" }));
    const onlyPi = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_read")]);
    expect(onlyPi?.toolName).toBe("mcp_pi_read");
    expect(JSON.parse(onlyPi!.decodedArgs)).toEqual({ path: "/foo/bar.ts" });

    const both = redirectNativeExecToTool(exec, [mcpTool("read"), mcpTool("mcp_pi_read")]);
    expect(both?.toolName).toBe("read");
  });

  test("readArgs forwards offset/limit when present on args (runtime extra fields)", () => {
    const exec = {
      id: 2,
      execId: "exec-read-off",
      message: {
        case: "readArgs" as const,
        value: { path: "/p", toolCallId: "tc", offset: 10, limit: 20 },
      },
    } as ExecServerMessage;
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_read")]);
    expect(JSON.parse(r!.decodedArgs)).toEqual({ path: "/p", offset: 10, limit: 20 });
  });

  test("writeArgs prefers mcp_pi_write and records nativeArgs for bridge encoding", () => {
    const exec = execServer(
      "writeArgs",
      create(WriteArgsSchema, {
        path: "/out.txt",
        fileText: "a\nb",
        toolCallId: "tcw",
        returnFileContentAfterWrite: false,
        fileBytes: new Uint8Array(),
      }),
    );
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_write")]);
    expect(r?.toolName).toBe("mcp_pi_write");
    expect(r?.nativeResultType).toBe("writeResult");
    expect(r?.nativeArgs?.path).toBe("/out.txt");
    expect(Number(r?.nativeArgs?.linesCreated)).toBe(2);
  });

  test("deleteArgs uses delete tool when present", () => {
    const exec = execServer("deleteArgs", create(DeleteArgsSchema, { path: "/tmp/x", toolCallId: "tcd" }));
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_delete")]);
    expect(r?.toolName).toBe("mcp_pi_delete");
    expect(r?.nativeResultType).toBe("deleteResult");
    expect(JSON.parse(r!.decodedArgs)).toEqual({ path: "/tmp/x" });
  });

  test("deleteArgs falls back to bash rm when no delete tool", () => {
    const exec = execServer("deleteArgs", create(DeleteArgsSchema, { path: "/tmp/y", toolCallId: "tcd" }));
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_bash")]);
    expect(r?.toolName).toBe("mcp_pi_bash");
    expect(r?.nativeResultType).toBe("deleteResult");
    const args = JSON.parse(r!.decodedArgs) as { command: string; description: string };
    expect(args.command).toContain("rm -rf");
    expect(args.command).toContain("/tmp/y");
  });

  test("fetchArgs maps to mcp_pi_fetch_content", () => {
    const exec = execServer("fetchArgs", create(FetchArgsSchema, { url: "https://example.com", toolCallId: "tcf" }));
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_fetch_content")]);
    expect(r?.toolName).toBe("mcp_pi_fetch_content");
    expect(JSON.parse(r!.decodedArgs)).toEqual({ url: "https://example.com" });
  });

  test("shellArgs maps to mcp_pi_bash with workdir and timeout", () => {
    const exec = execServer(
      "shellArgs",
      create(ShellArgsSchema, {
        command: "echo hi",
        workingDirectory: "/proj",
        timeout: 30_000,
        toolCallId: "tcs",
        simpleCommands: [],
        hasInputRedirect: false,
        hasOutputRedirect: false,
        isBackground: false,
        skipApproval: false,
        timeoutBehavior: 0,
      }),
    );
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_bash")]);
    expect(r?.nativeResultType).toBe("shellResult");
    expect(JSON.parse(r!.decodedArgs)).toEqual({
      command: "echo hi",
      description: "Executes shell command",
      workdir: "/proj",
      timeout: 30_000,
    });
  });

  test("shellStreamArgs marks shellStreamResult", () => {
    const exec = execServer(
      "shellStreamArgs",
      create(ShellArgsSchema, {
        command: "tail -f log",
        workingDirectory: "",
        timeout: 0,
        toolCallId: "tcss",
        simpleCommands: [],
        hasInputRedirect: false,
        hasOutputRedirect: false,
        isBackground: false,
        skipApproval: false,
        timeoutBehavior: 0,
      }),
    );
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_bash")]);
    expect(r?.nativeResultType).toBe("shellStreamResult");
  });

  test("lsArgs maps to mcp_pi_glob", () => {
    const exec = execServer("lsArgs", create(LsArgsSchema, { path: "/w", ignore: [], toolCallId: "tcl" }));
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_glob")]);
    expect(r?.toolName).toBe("mcp_pi_glob");
    expect(JSON.parse(r!.decodedArgs)).toEqual({ pattern: "*", path: "/w" });
    expect(r?.nativeResultType).toBe("lsResult");
  });

  test("grepArgs maps to mcp_pi_grep with pattern and optional include", () => {
    const exec = execServer(
      "grepArgs",
      create(GrepArgsSchema, {
        pattern: "TODO",
        path: "/src",
        glob: "*.ts",
        outputMode: "content",
        toolCallId: "tcg",
      }),
    );
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_grep")]);
    expect(r?.toolName).toBe("mcp_pi_grep");
    expect(JSON.parse(r!.decodedArgs)).toEqual({ pattern: "TODO", path: "/src", include: "*.ts" });
    expect(r?.nativeArgs?.outputMode).toBe("content");
  });

  test("grepArgs without pattern uses glob tool for glob-only search", () => {
    const exec = execServer(
      "grepArgs",
      create(GrepArgsSchema, {
        pattern: "",
        path: "/r",
        glob: "**/*.md",
        outputMode: "files_with_matches",
        toolCallId: "tcg",
      }),
    );
    const r = redirectNativeExecToTool(exec, [mcpTool("mcp_pi_glob")]);
    expect(r?.toolName).toBe("mcp_pi_glob");
    expect(JSON.parse(r!.decodedArgs)).toEqual({ pattern: "**/*.md", path: "/r" });
    expect(r?.nativeArgs?.outputMode).toBe("files_with_matches");
  });

  test("returns null when MCP exposes no compatible tool (fallback to proxy reject)", () => {
    const tools = [mcpTool("mcp_pi_only_other")];
    const readExec = execServer("readArgs", create(ReadArgsSchema, { path: "/", toolCallId: "x" }));
    expect(redirectNativeExecToTool(readExec, tools)).toBeNull();
    const grepExec = execServer(
      "grepArgs",
      create(GrepArgsSchema, { pattern: "a", toolCallId: "x" }),
    );
    expect(redirectNativeExecToTool(grepExec, tools)).toBeNull();
  });
});

describe("sendPendingExecResult", () => {
  const baseExec = (e: PendingExec): PendingExec => ({
    execId: "e1",
    execMsgId: 7,
    toolCallId: "tool-1",
    toolName: "mcp_pi_x",
    decodedArgs: "{}",
    ...e,
  });

  test("readResult encodes file text as ReadSuccess", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({
      nativeResultType: "readResult",
      nativeArgs: { path: "/a.txt" },
    }), "line1\nline2");
    const msgs = decodeBridgePayloads(writes);
    expect(msgs).toHaveLength(1);
    const em = msgs[0]!.message.case === "execClientMessage" ? msgs[0]!.message.value : null;
    expect(em?.message.case).toBe("readResult");
    const rr = em?.message.value as { result?: { case?: string; value?: { path?: string; totalLines?: number } } };
    expect(rr?.result?.case).toBe("success");
    expect(rr?.result?.value?.path).toBe("/a.txt");
    expect(rr?.result?.value?.totalLines).toBe(2);
  });

  test("writeResult encodes WriteSuccess with stats from nativeArgs", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({
      nativeResultType: "writeResult",
      nativeArgs: { path: "/w", fileSize: "12", linesCreated: "3" },
    }), "");
    const msgs = decodeBridgePayloads(writes);
    const em = msgs[0]!.message.case === "execClientMessage" ? msgs[0]!.message.value : null;
    expect(em?.message.case).toBe("writeResult");
    const wr = em?.message.value as { result?: { case?: string; value?: { path?: string } } };
    expect(wr?.result?.case).toBe("success");
    expect(wr?.result?.value?.path).toBe("/w");
  });

  test("shellResult passes stdout from MCP content", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({
      nativeResultType: "shellResult",
      nativeArgs: { command: "id", workingDirectory: "/tmp" },
    }), "uid=1000\n");
    const msgs = decodeBridgePayloads(writes);
    const em = msgs[0]!.message.case === "execClientMessage" ? msgs[0]!.message.value : null;
    expect(em?.message.case).toBe("shellResult");
    const sr = em?.message.value as { result?: { case?: string; value?: { stdout?: string; exitCode?: number } } };
    expect(sr?.result?.case).toBe("success");
    expect(sr?.result?.value?.stdout).toBe("uid=1000\n");
    expect(sr?.result?.value?.exitCode).toBe(0);
  });

  test("shellStreamResult emits multiple exec/control frames", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({
      nativeResultType: "shellStreamResult",
      nativeArgs: { command: "echo", workingDirectory: "" },
    }), "out\n");
    const msgs = decodeBridgePayloads(writes);
    const execCases = msgs
      .filter((m) => m.message.case === "execClientMessage")
      .map((m) => (m.message.value as ExecClientMessage).message.case);
    expect(execCases.filter((c) => c === "shellStream").length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m) => m.message.case === "execClientControlMessage")).toBe(true);
  });

  test("lsResult builds directory tree when MCP returns plain paths", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({
      nativeResultType: "lsResult",
      nativeArgs: { path: "/proj" },
    }), "/proj/src/a.ts\n/proj/README.md\n");
    const msgs = decodeBridgePayloads(writes);
    const em = msgs[0]!.message.case === "execClientMessage" ? msgs[0]!.message.value : null;
    expect(em?.message.case).toBe("lsResult");
  });

  test("grepResult parses rg-style content lines into GrepSuccess", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({
      nativeResultType: "grepResult",
      nativeArgs: {
        pattern: "foo",
        path: "/p",
        outputMode: "content",
      },
    }), "/p/a.ts:10: foo bar\n");
    const msgs = decodeBridgePayloads(writes);
    const em = msgs[0]!.message.case === "execClientMessage" ? msgs[0]!.message.value : null;
    expect(em?.message.case).toBe("grepResult");
  });

  test("without nativeResultType sends MCP-shaped tool result", () => {
    const { writes, bridge } = collectBridge();
    sendPendingExecResult(bridge, baseExec({ nativeResultType: undefined }), "custom text");
    const msgs = decodeBridgePayloads(writes);
    const em = msgs[0]!.message.case === "execClientMessage" ? msgs[0]!.message.value : null;
    expect(em?.message.case).toBe("mcpResult");
  });
});
