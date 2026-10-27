import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerMcpSurface,
  remoteMcpSurfaceComposition,
} from "../../dist/server-composition.js";

const rootUrl = new URL("../../", import.meta.url);
const root = fileURLToPath(rootUrl);
const read = (path) => JSON.parse(readFileSync(new URL(path, rootUrl), "utf8"));
const plugin = read("marketplace/openai/plugin.json");
const mcp = read("marketplace/openai/mcp.json");
const submission = read("marketplace/openai/chatgpt-app-submission.json");
const descriptor = read("src/__tests__/fixtures/openai-review-descriptor.snapshot.json");
const openai = plugin.extensions["com.openai"];

const EXPECTED_SKILLS = [
  "clients-crm",
  "expenses-and-vendors",
  "frihet-workspace",
  "invoices-and-quotes",
];

function textWithin(value, limit) {
  assert.equal(typeof value, "string");
  assert.ok(value.trim().length > 0 && value.length <= limit);
  assert.doesNotMatch(value, /[\u0000-\u0008\u000b-\u001f\u007f\t]/u);
}

function parseSkillFrontmatter(markdown, skillPath) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  assert.ok(match, `${skillPath} must start with YAML frontmatter`);
  const [, rawFrontmatter, body] = match;
  const nameMatch = rawFrontmatter.match(/^name:\s*([a-z0-9-]+)\s*$/mu);
  const licenseMatch = rawFrontmatter.match(/^license:\s*([^\n]+)\s*$/mu);
  const descMatch = rawFrontmatter.match(/^description:\s*>-\n((?:  [^\n]+\n?)+)/mu);
  assert.ok(nameMatch, `${skillPath} frontmatter must declare name`);
  assert.ok(licenseMatch, `${skillPath} frontmatter must declare license`);
  assert.ok(descMatch, `${skillPath} frontmatter must declare folded description`);
  const description = descMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return {
    name: nameMatch[1],
    license: licenseMatch[1].trim(),
    description,
    body,
  };
}

test("portable listing preserves identity, reviewed scope, onboardingSkill and public submission limits", () => {
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "frihet");
  assert.equal(plugin.version, "1.0.2");
  assert.equal(plugin.author.name, "Frihet");
  assert.deepEqual(
    Object.keys(openai).sort(),
    ["interface", "onboardingSkill", "publication", "review"],
  );
  assert.equal(openai.onboardingSkill, "./skills/frihet-workspace/SKILL.md");
  assert.ok(
    existsSync(join(root, "marketplace/openai", openai.onboardingSkill.slice(2))),
    "onboardingSkill must resolve to an existing skill in marketplace/openai/",
  );
  const listing = openai.interface;
  for (const [key, limit] of Object.entries({ displayName: 30, shortDescription: 30, longDescription: 4000, developerName: 80 })) {
    textWithin(listing[key], limit);
  }
  assert.equal(listing.category, "Business & Operations");
  assert.equal(listing.developerName, "Frihet");
  assert.doesNotMatch(
    listing.longDescription,
    /VICTOR BERTHELIUS PATO/i,
    "User-facing English About description must not expose personal legal-owner string",
  );
  assert.match(listing.longDescription, /four guided skills/i);
  assert.equal(listing.longDescription, submission.app_info.description);
  for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    textWithin(listing[key], 1024);
    const url = new URL(listing[key]);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username + url.password, "");
  }
  assert.equal(listing.defaultPrompt.length, 3);
  assert.equal(new Set(listing.defaultPrompt).size, 3);
  for (const prompt of listing.defaultPrompt) {
    textWithin(prompt, 128);
    assert.doesNotMatch(prompt, /@/);
  }
  assert.ok(listing.capabilities.length <= 20);
  listing.capabilities.forEach((value) => textWithin(value, 120));
  assert.deepEqual(openai.publication.countries, ["ES"]);
  assert.match(openai.publication.release_notes, /package 1\.0\.2/);
  assert.match(openai.publication.release_notes, /onboardingSkill/);
  assert.match(
    openai.publication.release_notes,
    /VICTOR BERTHELIUS PATO/,
    "Reviewer release_notes must accredit the legal owner alongside /privacy, /support, and /es/terms",
  );
  const spanish = openai.publication.translations["es-ES"];
  textWithin(spanish.subtitle, 30);
  textWithin(spanish.description, 4000);
  assert.doesNotMatch(
    spanish.description,
    /VICTOR BERTHELIUS PATO/i,
    "User-facing Spanish About description must not expose personal legal-owner string",
  );
  assert.match(spanish.description, /cuatro skills guiadas/i);
  assert.deepEqual(mcp, {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { frihet: { type: "streamable-http", url: "https://openai-mcp.frihet.io/mcp" } },
  });
  assert.equal(mcp.mcpServers.frihet.url, descriptor.oauth.protectedResourceMcp.resource);
  assert.deepEqual(Object.keys(openai.review), ["test_cases"], "video remains absent until a real recording exists");
  for (const [kind, source, count] of [["positive", submission.test_cases, 5], ["negative", submission.negative_test_cases, 3]]) {
    const cases = openai.review.test_cases[kind];
    assert.equal(cases.length, count);
    cases.forEach((entry, index) => {
      textWithin(entry.description, 4000);
      assert.equal(entry.prompt, source[index].user_prompt);
      assert.equal(entry.expected_behavior, source[index].expected_output);
      assert.equal(entry.tools_triggered ?? null, source[index].tools_triggered);
      for (const name of (entry.tools_triggered ?? "").split(",").filter(Boolean)) {
        assert.ok(descriptor.tools.some((tool) => tool.name === name.trim()));
      }
    });
  }
  assert.doesNotMatch(JSON.stringify({ plugin, mcp }), /"(?:test_credentials|reviewer_instructions|headers|env|apps|hooks)"/);
});

const EXPLICITLY_NAMED_OUT_OF_SCOPE_TOOLS = new Set([
  "delete_product",
  "update_invoice",
  "delete_invoice",
  "send_invoice",
  "mark_invoice_paid",
  "update_quote",
  "delete_expense",
  "delete_vendor",
  "delete_client",
  "list_transactions",
  "list_bank_accounts",
]);

function validateSkillToolReferences(body, approvedToolSet, relPath) {
  const [supportedSection = "", ...restSections] = body.split(/^## 1\./mu);
  const workflowSection = restSections.join("## 1.");
  const coveredInSkill = new Set();

  for (const [, token] of supportedSection.matchAll(/`([a-z]+_[a-z_*]+)`/gu)) {
    if (token.endsWith("_*")) continue;
    assert.ok(
      approvedToolSet.has(token),
      `${relPath} Supported tools section lists unapproved tool: ${token}`,
    );
    coveredInSkill.add(token);
  }

  // Split workflow body into sentences/clauses and lines so every unapproved tool mention
  // is validated in its local syntactic context.
  const lines = workflowSection.split("\n");
  for (const line of lines) {
    const clauses = line.split(/(?<=[.!?;])\s+/u);
    for (const clause of clauses) {
      for (const [, token] of clause.matchAll(/`([a-z]+_[a-z_*]+)`/gu)) {
        if (token.endsWith("_*") || approvedToolSet.has(token)) continue;
        assert.ok(
          EXPLICITLY_NAMED_OUT_OF_SCOPE_TOOLS.has(token),
          `${relPath} references unknown/unapproved tool \`${token}\``,
        );
        const hasExplicitProhibition =
          /\b(?:not\s+available|not\s+exposed|not\s+included|does\s+not\s+include|does\s+not\s+access|no\s+`[a-z_]+`(?:\s+tool)?|outside\s+(?:this\s+connector|scope)|never\s+(?:call|use|invoke)|do\s+not\s+(?:call|use|invoke))\b/iu.test(
            clause,
          );
        assert.ok(
          hasExplicitProhibition,
          `${relPath} mentions excluded tool \`${token}\` outside an explicit prohibition clause: "${clause.trim()}"`,
        );

        // Reject any positive/imperative instruction to call/use/invoke/run/try the excluded tool,
        // even if another part of the sentence contains a negative marker.
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const imperativeBeforeTool = new RegExp(
          `\\b(?!never\\s+|not\\s+|no\\s+|without\\s+)(?:call|calling|use|using|invoke|invoking|run|running|execute|executing|trigger|triggering|recommend|try)\\b[^.!?;\\n]*\`${escaped}\``,
          "iu",
        );
        const negatedImperative = new RegExp(
          `\\b(?:never|do\\s+not|don't|cannot|can't|without)\\s+(?:ever\\s+)?(?:call|calling|use|using|invoke|invoking|run|running|execute|executing|trigger|triggering)\\b[^.!?;\\n]*\`${escaped}\``,
          "iu",
        );
        if (imperativeBeforeTool.test(clause) && !negatedImperative.test(clause)) {
          assert.fail(
            `${relPath} instructs or recommends calling excluded tool \`${token}\`: "${clause.trim()}"`,
          );
        }
      }
    }
  }

  return coveredInSkill;
}

test("packaged skills cover the exact 33-tool contract, onboarding workflow, and mandatory safety rules", () => {
  const approvedToolSet = new Set(descriptor.tools.map((tool) => tool.name));
  assert.equal(approvedToolSet.size, 33);

  const coveredApprovedTools = new Set();
  const parsedSkills = new Map();

  for (const skillName of EXPECTED_SKILLS) {
    const relPath = `marketplace/openai/skills/${skillName}/SKILL.md`;
    const fullPath = join(root, relPath);
    assert.ok(existsSync(fullPath), `Missing skill file: ${relPath}`);
    const markdown = readFileSync(fullPath, "utf8");
    const parsed = parseSkillFrontmatter(markdown, relPath);
    assert.equal(parsed.name, skillName, `${relPath} frontmatter name must match directory`);
    assert.equal(parsed.license, "MIT");
    textWithin(parsed.description, 600);
    parsedSkills.set(skillName, { markdown, ...parsed });

    // Check internal relative markdown links if any exist.
    for (const [, target] of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      assert.ok(
        existsSync(join(dirname(fullPath), target.split("#")[0])),
        `Broken relative link in ${relPath}: ${target}`,
      );
    }

    const skillCovered = validateSkillToolReferences(parsed.body, approvedToolSet, relPath);
    for (const toolName of skillCovered) coveredApprovedTools.add(toolName);

    // Every skill must enforce pagination truth and unknown-write timeout recovery.
    assert.match(parsed.body, /nextCursor/, `${relPath} must instruct checking nextCursor pagination`);
    assert.match(parsed.body, /partial page/i, `${relPath} must require labeling partial pages`);
    assert.match(parsed.body, /timeout/i, `${relPath} must include unknown write / timeout recovery instructions`);
    assert.match(parsed.body, /confirm:\s*true/, `${relPath} must document confirm: true write gating`);
  }

  assert.deepEqual(
    [...coveredApprovedTools].sort(),
    [...approvedToolSet].sort(),
    "The four OpenAI skills together must cover all 33 reviewed tools",
  );

  // Specific regression checks per skill:
  const workspaceSkill = parsedSkills.get("frihet-workspace").body;
  assert.match(workspaceSkill, /onboardingSkill/);
  assert.match(workspaceSkill, /Do NOT call `get_business_context` or any other MCP tool/);
  assert.match(workspaceSkill, /generic question about plugin capabilities, setup, or limits must never read private workspace records/i);
  assert.match(workspaceSkill, /get_business_context/);
  assert.match(workspaceSkill, /Never invent prices or tax rates/i);
  assert.match(workspaceSkill, /Make the minimum calls needed to complete the user's task/i);
  assert.match(workspaceSkill, /until all pages are retrieved/i);

  const invoicesSkill = parsedSkills.get("invoices-and-quotes").body;
  assert.match(invoicesSkill, /status:\s*"draft"/);
  assert.match(invoicesSkill, /Never claim.*issued, finalized, emailed/i);
  assert.match(invoicesSkill, /Never invent amounts, quantities, dates, discounts, or tax treatment/i);
  assert.match(invoicesSkill, /Minimum necessary calls/i);
  assert.match(invoicesSkill, /disambiguate an incomplete input/i);
  assert.match(invoicesSkill, /maintain uncertainty/i);
  assert.match(invoicesSkill, /Cancels.*non-draft quote/i);

  const expensesSkill = parsedSkills.get("expenses-and-vendors").body;
  assert.match(expensesSkill, /Never invent `description`, `amount`, `date`, or `taxDeductible`/);
  assert.match(expensesSkill, /only the specific required fields that are actually missing/i);
  assert.match(expensesSkill, /separate backend step/);
  assert.match(expensesSkill, /`amount` and supplier identity \(`vendor` \/ `vendorId`\) cannot be changed/);

  const clientsSkill = parsedSkills.get("clients-crm").body;
  assert.match(clientsSkill, /Always resolve `clientId` first/);
  assert.match(clientsSkill, /untrusted record data/i);
  assert.match(clientsSkill, /Do not invent `description` text when the user only provided `title`/i);
  assert.match(clientsSkill, /does \*\*not\*\* send an email, place a phone call/i);
  assert.match(clientsSkill, /permanent and cannot be undone/i);
});

test("skill tool-reference validator rejects imperative or positive references to excluded or unknown tools", () => {
  const approvedToolSet = new Set(descriptor.tools.map((tool) => tool.name));

  // 1. Valid negative disclosure passes:
  const validBody = [
    "## Supported tools in this workflow",
    "- `create_invoice`, `get_invoice`",
    "## 1. Workflow",
    "- This connector does not include `send_invoice` or `delete_product`.",
    "- Do not call `delete_invoice` in this connector.",
  ].join("\n");
  assert.deepEqual(
    [...validateSkillToolReferences(validBody, approvedToolSet, "synthetic/SKILL.md")].sort(),
    ["create_invoice", "get_invoice"],
  );

  // 2. Excluded tool listed in Supported tools is rejected:
  assert.throws(
    () =>
      validateSkillToolReferences(
        "## Supported tools\n- `create_invoice`, `send_invoice`\n## 1. Workflow\n",
        approvedToolSet,
        "synthetic/SKILL.md",
      ),
    /Supported tools section lists unapproved tool: send_invoice/,
  );

  // 3. Direct imperative instruction to call an excluded tool is rejected:
  assert.throws(
    () =>
      validateSkillToolReferences(
        "## Supported tools\n- `create_invoice`\n## 1. Workflow\nCall `send_invoice` to email the invoice.\n",
        approvedToolSet,
        "synthetic/SKILL.md",
      ),
    /mentions excluded tool `send_invoice` outside an explicit prohibition clause/,
  );

  // 4. Mixed clause that has a negative phrase AND recommends calling an excluded tool is rejected:
  assert.throws(
    () =>
      validateSkillToolReferences(
        "## Supported tools\n- `create_invoice`\n## 1. Workflow\nAlthough `update_invoice` is not available in this connector, call `send_invoice` to deliver the draft.\n",
        approvedToolSet,
        "synthetic/SKILL.md",
      ),
    /instructs or recommends calling excluded tool `send_invoice`/,
  );

  // 5. Unknown/invented tool name is rejected even inside a negative clause:
  assert.throws(
    () =>
      validateSkillToolReferences(
        "## Supported tools\n- `create_invoice`\n## 1. Workflow\nNote that `invented_magic_tool` is not available in this connector.\n",
        approvedToolSet,
        "synthetic/SKILL.md",
      ),
    /references unknown\/unapproved tool `invented_magic_tool`/,
  );
});

test("ZIP is reproducible, contains only reviewed files + 4 skills and leaves npm built artifacts clean", () => {
  const archive = () => execFileSync("python3", ["scripts/package-openai-plugin.py"], { cwd: root, encoding: "utf8" }).trim();
  const archivePath = archive();
  assert.equal(archivePath, fileURLToPath(new URL(`marketplace/openai/dist/${plugin.name}-${plugin.version}.zip`, rootUrl)));
  const first = readFileSync(archivePath);
  assert.deepEqual(readFileSync(archive()), first);
  execFileSync("python3", ["-c", `
import hashlib, json, pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
archive_path = pathlib.Path(sys.argv[2])
checksum_path = archive_path.with_name(f"{archive_path.name}.sha256")
inventory_path = archive_path.with_name(f"{archive_path.stem}-inventory.json")
assert checksum_path.exists(), "Missing .sha256 sidecar file"
assert inventory_path.exists(), "Missing -inventory.json sidecar file"
archive_sha256 = hashlib.sha256(archive_path.read_bytes()).hexdigest()
assert checksum_path.read_text(encoding='utf-8') == f"{archive_sha256}  {archive_path.name}\\n"
inventory = json.loads(inventory_path.read_text(encoding='utf-8'))
assert inventory['name'] == 'frihet'
assert inventory['version'] == '1.0.2'
assert inventory['zipFile'] == archive_path.name
assert inventory['zipSizeBytes'] == len(archive_path.read_bytes())
assert inventory['zipSha256'] == archive_sha256
assert inventory['fileCount'] == 9
with zipfile.ZipFile(archive_path) as bundle:
    expected = {
        'plugin.json',
        'mcp.json',
        'assets/frihet-composer.png',
        'assets/frihet-composer-dark.png',
        'assets/frihet-directory-dark.png',
        'skills/frihet-workspace/SKILL.md',
        'skills/invoices-and-quotes/SKILL.md',
        'skills/expenses-and-vendors/SKILL.md',
        'skills/clients-crm/SKILL.md',
    }
    assert set(bundle.namelist()) == expected, f"Unexpected ZIP contents: {set(bundle.namelist())}"
    assert bundle.testzip() is None
    inv_by_path = {item['path']: item for item in inventory['files']}
    assert set(inv_by_path.keys()) == expected
    for entry in bundle.infolist():
        assert entry.date_time == (1980, 1, 1, 0, 0, 0)
        assert entry.external_attr >> 16 == 0o100644
        data = bundle.read(entry)
        assert inv_by_path[entry.filename]['sizeBytes'] == len(data)
        assert inv_by_path[entry.filename]['sha256'] == hashlib.sha256(data).hexdigest()
        if entry.filename.startswith('assets/'):
            source_path = root / 'marketplace/openai' / pathlib.Path(entry.filename).name
        else:
            source_path = root / 'marketplace/openai' / entry.filename
        assert data == source_path.read_bytes(), f"Content mismatch for {entry.filename}"
        if entry.filename.endswith('.png'):
            assert data[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
            assert int.from_bytes(data[16:20], 'big') == 512
            assert int.from_bytes(data[20:24], 'big') == 512
    plugin_json = json.loads(bundle.read('plugin.json'))
    openai_ext = plugin_json['extensions']['com.openai']
    assert openai_ext['onboardingSkill'].removeprefix('./') in expected
    manifest = openai_ext['interface']
    for key in ('logo', 'logoDark', 'composerIcon', 'composerIconDark'):
        assert manifest[key].removeprefix('./') in expected
`, root, archivePath], { cwd: root, stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/check-no-analytics-emitters.mjs", "--built"], { cwd: root, stdio: "pipe" });
});

// Integration test of the MCP server surface (InMemoryTransport + McpServer) with programmed client.callTool requests.
// This verifies server-side schema/contract invariants; conversational model tool-selection is evaluated separately.
test("MCP server integration test: OpenAI 33-tool surface enforces schema, draft status, pagination, and write-confirmation contracts", async () => {
  const calls = [];
  let invoiceTimeoutSimulated = false;

  const mockApiClient = new Proxy(
    {},
    {
      get(_target, method) {
        return async (...args) => {
          calls.push({ method: String(method), args });
          switch (method) {
            case "getBusinessContext":
              return {
                business: {
                  name: "Estudio Atlántico SL",
                  currency: "EUR",
                  language: "es",
                  country: "ES",
                },
                defaults: { taxRate: 21, dueDays: 30, currency: "EUR" },
                plan: {
                  name: "pro",
                  invoices: { used: 4, limit: 100 },
                  expenses: { used: 2, limit: "unlimited" },
                  aiMessages: { used: 10, limit: 500 },
                },
                currentMonth: {
                  revenue: 3200,
                  expenses: 450,
                  profit: 2750,
                  invoiceCount: 4,
                  expenseCount: 2,
                },
                recentActivity: {
                  lastInvoice: { client: "Acme SL", date: "2026-10-20", number: "INV-2026-0004" },
                  lastExpense: { amount: 45.99, date: "2026-10-18", vendor: "Office Depot Canarias" },
                  overdueCount: 0,
                  overdueAmount: 0,
                  unpaidCount: 1,
                },
                topClients: [{ name: "Acme SL", totalRevenue: 2000, invoiceCount: 2 }],
              };
            case "listProducts":
              return {
                data: [
                  { id: "prod_1", name: "Consultoría estratégica", unitPrice: 100, taxRate: 21, isActive: true },
                ],
                total: 54,
                limit: 1,
                offset: 0,
                nextCursor: "prod_2",
              };
            case "createProduct":
              return {
                id: "prod_55",
                name: args[0].name,
                unitPrice: args[0].unitPrice,
                taxRate: args[0].taxRate ?? 21,
                description: args[0].description,
              };
            case "listInvoices":
              return {
                data: [
                  {
                    id: "inv_1",
                    invoiceNumber: "INV-2026-0001",
                    clientName: "Acme SL",
                    issueDate: "2026-10-01",
                    dueDate: "2026-10-31",
                    status: "draft",
                    total: 605,
                  },
                ],
                total: 47,
                limit: 1,
                offset: 0,
                nextCursor: "inv_2",
              };
            case "createInvoice":
              if (invoiceTimeoutSimulated) {
                throw new Error("Request timed out after upstream write");
              }
              return {
                id: "inv_99",
                invoiceNumber: "INV-2026-0099",
                clientId: "cli_1",
                clientName: args[0].clientName,
                issueDate: args[0].issueDate ?? "2026-10-27",
                dueDate: args[0].dueDate ?? "2026-11-26",
                status: "draft",
                items: args[0].items,
                taxRate: args[0].taxRate ?? 21,
              };
            case "searchInvoices":
              return {
                data: [
                  {
                    id: "inv_99",
                    invoiceNumber: "INV-2026-0099",
                    clientName: "Acme SL",
                    issueDate: "2026-10-27",
                    dueDate: "2026-11-26",
                    status: "draft",
                    total: 605,
                  },
                ],
                total: 1,
                limit: 20,
                offset: 0,
              };
            case "getInvoice":
              return {
                id: args[0],
                invoiceNumber: "INV-2026-0099",
                clientId: "cli_1",
                clientName: "Acme SL",
                issueDate: "2026-10-27",
                dueDate: "2026-11-26",
                status: "draft",
                items: [{ description: "Consulting", quantity: 5, unitPrice: 100 }],
                taxRate: 21,
                total: 605,
              };
            case "deleteQuote":
              return {
                id: args[0],
                success: true,
                result: args[0] === "quo_sent_1" ? "cancelled" : "deleted",
              };
            case "createExpense":
              return {
                id: "exp_10",
                description: args[0].description,
                amount: args[0].amount,
                date: args[0].date,
                taxDeductible: args[0].taxDeductible,
                category: args[0].category ?? "office",
                vendor: args[0].vendor ?? "Office Depot Canarias",
                vendorId: "ven_1",
              };
            case "updateExpense":
              return {
                id: args[0],
                description: args[1].description ?? "Office supplies",
                amount: 45.99,
                date: args[1].date ?? "2026-08-28",
                taxDeductible: args[1].taxDeductible ?? false,
                category: args[1].category ?? "office",
                vendor: "Office Depot Canarias",
                vendorId: "ven_1",
              };
            case "listClients":
              return {
                data: [{ id: "cli_1", name: "Acme SL", email: "billing@acme.example", stage: "active" }],
                total: 1,
                limit: 20,
                offset: 0,
              };
            case "getClient":
              return { id: args[0], name: "Acme SL", email: "billing@acme.example", phone: "+34928000000", stage: "active" };
            case "logClientActivity":
              return {
                type: args[1].type,
                title: args[1].title,
                description: args[1].description,
                timestamp: "2026-10-27T18:00:00Z",
              };
            case "deleteClientNote":
              return { id: args[1], success: true };
            default:
              return { data: [], total: 0, limit: 20, offset: 0 };
          }
        };
      },
    },
  );

  const server = new McpServer({ name: "frihet-openai-1.0.2-eval", version: "1.0.2" });
  registerMcpSurface(server, mockApiClient, remoteMcpSurfaceComposition(true, false));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "openai-skill-eval-client", version: "1.0.2" }, { capabilities: {} });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // 1. Out-of-scope verification: banking, payroll, tax filings, and invoice send/delete are absent.
    const listed = await client.listTools();
    const toolNames = new Set(listed.tools.map((t) => t.name));
    assert.equal(toolNames.size, 33);
    for (const forbidden of [
      "list_transactions",
      "list_bank_accounts",
      "payroll_export",
      "send_invoice",
      "mark_invoice_paid",
      "delete_invoice",
      "update_invoice",
      "delete_expense",
      "delete_client",
      "delete_product",
      "get_modelo_303_summary",
    ]) {
      assert.equal(toolNames.has(forbidden), false, `${forbidden} must not be exposed in OpenAI mode`);
    }

    // 2. Onboarding & Workspace skill (frihet-workspace):
    const ctxResult = await client.callTool({ name: "get_business_context", arguments: {} });
    assert.equal(ctxResult.isError ?? false, false);
    assert.equal(ctxResult.structuredContent.business.name, "Estudio Atlántico SL");

    // Pagination truth on list_products (Regression #3):
    const prodPage = await client.callTool({ name: "list_products", arguments: { isActive: true, limit: 1 } });
    assert.equal(prodPage.structuredContent.total, 54);
    assert.equal(prodPage.structuredContent.nextCursor, "prod_2");
    assert.equal(prodPage.structuredContent.data.length, 1);

    // 3. Invoices & Quotes skill (invoices-and-quotes):
    // Regression #2: Incomplete input (missing items or missing confirm) is rejected without calling API.
    const callCountBeforeBadInvoice = calls.length;
    const badInvoice = await client.callTool({
      name: "create_invoice",
      arguments: { clientName: "Acme SL", items: [{ description: "Consulting", quantity: 5, unitPrice: 100 }], confirm: false },
    });
    assert.equal(badInvoice.isError, true, "create_invoice with confirm: false must be rejected");
    assert.equal(calls.length, callCountBeforeBadInvoice, "Rejected write must not reach upstream API");

    // Regression #1: Authorized create_invoice creates a DRAFT (status === "draft") with externalEffects, never issued/sent.
    const draftInvoice = await client.callTool({
      name: "create_invoice",
      arguments: {
        clientName: "Acme SL",
        items: [{ description: "Consulting", quantity: 5, unitPrice: 100 }],
        taxRate: 21,
        confirm: true,
      },
    });
    assert.equal(draftInvoice.isError ?? false, false);
    assert.equal(draftInvoice.structuredContent.status, "draft");
    assert.equal(draftInvoice.structuredContent.invoiceNumber, "INV-2026-0099");
    assert.ok(draftInvoice.structuredContent.externalEffects, "Draft creation must disclose externalEffects");

    // Regression #4: Unknown write outcome / timeout recovery on create_invoice:
    // Simulate a timeout and verify recovery via search_invoices + get_invoice instead of blind retry.
    invoiceTimeoutSimulated = true;
    const timedOutWrite = await client.callTool({
      name: "create_invoice",
      arguments: {
        clientName: "Acme SL",
        items: [{ description: "Consulting", quantity: 5, unitPrice: 100 }],
        taxRate: 21,
        confirm: true,
      },
    });
    assert.equal(timedOutWrite.isError, true);
    invoiceTimeoutSimulated = false;

    const searchRecovery = await client.callTool({
      name: "search_invoices",
      arguments: { query: "Acme SL", status: "draft" },
    });
    assert.equal(searchRecovery.structuredContent.data[0].id, "inv_99");
    const detailRecovery = await client.callTool({
      name: "get_invoice",
      arguments: { id: "inv_99" },
    });
    assert.equal(detailRecovery.structuredContent.invoiceNumber, "INV-2026-0099");
    assert.equal(detailRecovery.structuredContent.status, "draft");

    // Quote cancellation vs deletion truth:
    const cancelledQuote = await client.callTool({
      name: "delete_quote",
      arguments: { id: "quo_sent_1", confirm: true },
    });
    assert.equal(cancelledQuote.structuredContent.result.outcome, "cancelled");
    assert.equal(cancelledQuote.structuredContent.result.status, "cancelled");

    // 4. Expenses & Vendors skill (expenses-and-vendors):
    // Regression #2: Missing taxDeductible or forbidden amount mutation on update_expense is rejected.
    const callsBeforeExpense = calls.length;
    const missingTaxDeductible = await client.callTool({
      name: "create_expense",
      arguments: { description: "Office supplies", amount: 45.99, date: "2026-08-28", confirm: true },
    });
    assert.equal(missingTaxDeductible.isError, true, "create_expense without taxDeductible must fail schema validation");
    const forbiddenAmountUpdate = await client.callTool({
      name: "update_expense",
      arguments: { id: "exp_10", amount: 99.99, confirm: true },
    });
    assert.equal(forbiddenAmountUpdate.isError, true, "update_expense must reject amount modifications");
    assert.equal(calls.length, callsBeforeExpense, "Invalid expense mutations must not reach API");

    const validExpense = await client.callTool({
      name: "create_expense",
      arguments: {
        description: "Office supplies",
        amount: 45.99,
        date: "2026-08-28",
        taxDeductible: false,
        category: "office",
        vendor: "Office Depot Canarias",
        confirm: true,
      },
    });
    assert.equal(validExpense.isError ?? false, false);
    assert.equal(validExpense.structuredContent.taxDeductible, false);
    assert.ok(validExpense.structuredContent.externalEffects);

    // 5. Clients & CRM skill (clients-crm):
    const clientsList = await client.callTool({ name: "list_clients", arguments: {} });
    const targetClientId = clientsList.structuredContent.data[0].id;
    assert.equal(targetClientId, "cli_1");

    const loggedCall = await client.callTool({
      name: "log_client_activity",
      arguments: {
        clientId: targetClientId,
        type: "call",
        title: "Quarterly review call",
        confirm: true,
      },
    });
    assert.equal(loggedCall.isError ?? false, false);
    assert.equal(loggedCall.structuredContent.type, "call");
    assert.ok(loggedCall.structuredContent.externalEffects);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
});
