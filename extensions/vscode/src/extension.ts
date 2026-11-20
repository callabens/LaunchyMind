import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { diagnosticsFromFindings, type ReportFinding } from "./map";

interface ScanBody {
  findings: ReportFinding[];
  projectPath: string;
}

function folder(): vscode.WorkspaceFolder {
  const found = vscode.workspace.workspaceFolders?.[0];
  if (!found) throw new Error("Open a folder before running LaunchyMind.");
  return found;
}

function cliArgs(project: string, extra: string[]): { command: string; args: string[] } {
  const local = join(project, "apps", "cli", "src", "index.ts");
  const offline = vscode.workspace.getConfiguration("launchymind").get("offline") === true;
  const flags = offline ? ["--offline"] : [];
  if (existsSync(local)) return { command: process.execPath, args: ["--experimental-strip-types", local, ...extra, ...flags] };
  return { command: "launchymind", args: [...extra, ...flags] };
}

function run(project: string, extra: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const spec = cliArgs(project, extra);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { cwd: project });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function scan(diagnostics: vscode.DiagnosticCollection): Promise<ScanBody> {
  const root = folder();
  const result = await run(root.uri.fsPath, ["scan", root.uri.fsPath, "--json"]);
  if (!result.stdout.trim()) throw new Error(result.stderr || "LaunchyMind returned no report.");
  const report = JSON.parse(result.stdout) as ScanBody;
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const draft of diagnosticsFromFindings(report.findings)) {
    const file = draft.path ? (draft.path.startsWith("/") ? draft.path : join(root.uri.fsPath, draft.path)) : join(root.uri.fsPath, ".launchymind", "project.yaml");
    const line = Math.max(0, (draft.line ?? 1) - 1);
    const range = new vscode.Range(line, 0, line, 1);
    const diagnostic = new vscode.Diagnostic(range, draft.message, severity(draft.severity));
    diagnostic.source = "LaunchyMind";
    diagnostic.code = draft.sourceUrl ? { value: draft.ruleId, target: vscode.Uri.parse(draft.sourceUrl) } : draft.ruleId;
    const list = byFile.get(file) ?? [];
    list.push(diagnostic);
    byFile.set(file, list);
  }
  diagnostics.clear();
  for (const [file, items] of byFile) diagnostics.set(vscode.Uri.file(file), items);
  return report;
}

function severity(value: "error" | "warning" | "information"): vscode.DiagnosticSeverity {
  if (value === "error") return vscode.DiagnosticSeverity.Error;
  if (value === "warning") return vscode.DiagnosticSeverity.Warning;
  return vscode.DiagnosticSeverity.Information;
}

async function pickRule(report: ScanBody): Promise<string | undefined> {
  const ids = [...new Set(report.findings.filter((item) => item.status === "fail" || item.status === "unchecked").map((item) => item.ruleId))];
  return vscode.window.showQuickPick(ids, { placeHolder: "Rule to propose or apply" });
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("launchymind");
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(vscode.commands.registerCommand("launchymind.scan", async () => {
    try {
      await scan(diagnostics);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("launchymind.proposeFix", async () => {
    try {
      const root = folder();
      const report = await scan(diagnostics);
      const ruleId = await pickRule(report);
      if (!ruleId) return;
      const result = await run(root.uri.fsPath, ["fix", "propose", ruleId, "--project", root.uri.fsPath]);
      const channel = vscode.window.createOutputChannel("LaunchyMind");
      channel.clear();
      channel.appendLine(result.stdout || result.stderr);
      channel.show(true);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("launchymind.applyFix", async () => {
    try {
      const root = folder();
      const report = await scan(diagnostics);
      const ruleId = await pickRule(report);
      if (!ruleId) return;
      const proposed = await run(root.uri.fsPath, ["fix", "propose", ruleId, "--project", root.uri.fsPath]);
      const approved = await vscode.window.showWarningMessage(
        `Approve writing the ${ruleId} fix? Nothing is written until you approve. ${proposed.stdout.slice(0, 400)}`,
        { modal: true },
        "Approve",
      );
      if (approved !== "Approve") return;
      const applied = await run(root.uri.fsPath, ["fix", root.uri.fsPath, "--rule", ruleId, "--yes"]);
      vscode.window.showInformationMessage(applied.stderr || applied.stdout || "LaunchyMind finished.");
      await scan(diagnostics);
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }));
}

export function deactivate(): void {
  return undefined;
}
