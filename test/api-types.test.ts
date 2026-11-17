import assert from "node:assert/strict";
import { it } from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createUsageClient, formatUsageReport } from "pi-universal-usage/api";
import type { ProviderInfo, UsageClient, UsageRefresh, UsageReport, UsageResult, UsageSelection } from "pi-universal-usage/api";

// Compiled by the existing check, not invoked: this is a consumer of the public
// package subpath, not an import of the chosen implementation file layout.
function consumer(registry: ModelRegistry, client: UsageClient, report: UsageReport) {
  const refresh: UsageRefresh = "if-needed";
  const providers: readonly string[] = ["deepseek"];
  const models = [{ provider: "deepseek", modelId: "chat" }] as const;
  const selection: UsageSelection = { models };
  const list: ProviderInfo[] = client.listProviders();
  const pending: Promise<UsageReport> = client.read({ selection, refresh });
  const result: UsageResult | undefined = report.results[0];
  const text: string = formatUsageReport(report);
  const owned: UsageClient = createUsageClient({ modelRegistry: registry });
  void client.read({ selection: { providers } });
  void client.read({ selection: { active: true }, signal: new AbortController().signal });
  // @ts-expect-error the selection union is exclusive, including structural assignment
  const mixed: UsageSelection = { active: true, providers };
  // @ts-expect-error there is no arbitrary quota URL input
  void client.read({ url: "https://example.invalid/quota" });
  // @ts-expect-error read does not accept credentials
  void client.read({ auth: "secret" });
  // @ts-expect-error reads cannot raise concurrency without configuration bounds
  void client.read({ concurrency: 999 });
  // @ts-expect-error only the three documented refresh modes are supported
  void client.read({ refresh: "always" });
  // @ts-expect-error active:false is not a selection
  void client.read({ selection: { active: false } });
  // @ts-expect-error internal identity is not part of the public DTO
  const identity = result?.identity;
  owned.dispose();
  return { list, pending, result, text, mixed, identity };
}
void consumer;

it("exports the typed public factory and pure formatter at the package subpath", () => {
  assert.equal(typeof createUsageClient, "function");
  assert.equal(typeof formatUsageReport, "function");
});
