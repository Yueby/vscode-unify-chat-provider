import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import * as vscode from "vscode";

export async function runGitHubUpdateE2E(): Promise<void> {
  const extensionsDir = process.env["UCP_E2E_EXTENSIONS_DIR"];
  assert.ok(extensionsDir, "Update E2E requires the isolated runner extensions directory");
  const underTest = vscode.extensions.getExtension(
    process.env["UCP_E2E_EXTENSION_ID"] ?? "Yueby.vscode-unify-chat-provider",
  );
  assert.ok(underTest?.isActive, "The extension under test must already be active");
  assert.equal(underTest.id.split(".")[0].toLowerCase(), "yueby");
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("unifyChatProvider.checkForUpdates"), "The update command must be registered");
  assert.ok(commands.includes("unifyChatProvider.update.test.run"), "The test-only update controller must be registered");
  assert.equal(
    vscode.workspace.getConfiguration("unifyChatProvider")
      .inspect<boolean>("updates.checkAutomatically")?.defaultValue,
    true,
    "Automatic update checks must default to true",
  );

  const scratch = await mkdtemp(path.join(tmpdir(), "ucp-update-e2e-"));
  try {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>`);
    zip.file("extension.vsixmanifest", `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="ucp-update-e2e-fixture" Version="0.0.2" Publisher="Yueby" />
    <DisplayName>UCP Update E2E Fixture</DisplayName>
    <Description xml:space="preserve">Isolated native update installation fixture</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.115.0" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>`);
    zip.file("extension/package.json", JSON.stringify({
      publisher: "Yueby",
      name: "ucp-update-e2e-fixture",
      displayName: "UCP Update E2E Fixture",
      description: "Isolated native update installation fixture",
      version: "0.0.2",
      engines: { vscode: "^1.115.0" },
    }));
    const vsixPath = path.join(scratch, "fixture.vsix");
    await writeFile(vsixPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    const report = await vscode.commands.executeCommand<unknown>(
      "unifyChatProvider.update.test.run", vsixPath, extensionsDir,
    );
    assert.ok(typeof report === "object" && report !== null && !Array.isArray(report));
    assert.ok(Object.values(report).every((value: unknown) => typeof value === "number" || typeof value === "boolean"));
    assert.ok("progressCount" in report && typeof report.progressCount === "number" && report.progressCount >= 2);
    assert.deepEqual(report, {
      requestCount: 3,
      confirmCount: 1,
      progressCount: report.progressCount,
      installCount: 1,
      installedCount: 1,
      noUpdateCount: 0,
      errorCount: 0,
      installedManifestMatches: true,
      downloadRemoved: true,
    });
    console.log("Extension Host GitHub update native installation E2E passed");
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
