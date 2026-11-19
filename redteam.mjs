#!/usr/bin/env node
// Live red-team harness for the WizardOfCoin intelligent contract on
// GenLayer Studio Dev (chain ID 61997, RPC https://studio-dev.genlayer.com/api).
//
//   node redteam.mjs                    # make test account, fund, deploy, attack, report
//   node redteam.mjs --fund manual      # print the address and wait until you send GEN to it
//   node redteam.mjs --address 0x...    # attack an already deployed WizardOfCoin
//
// Studio Dev is a fee-charging Consensus v0.6 deployment: every deploy/write sends
// fees { distribution, feeValue } estimated by the SDK, paid from the test account's GEN balance.
// Needs the genlayer-js 2.x release candidate (it ships the `studioDevnet` preset).
// Test keys and the deployed address are kept in .wizard-state.json (git-ignored).

import { parseArgs } from "node:util";
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { ATTACKS } from "./attacks.mjs";

const CHAIN_ID = 61997;
const DEFAULT_RPC = "https://studio-dev.genlayer.com/api";
const EXPLORER = "https://explorer-studio-dev.genlayer.com";

const { values: opt } = parseArgs({
  options: {
    address: { type: "string", default: process.env.CONTRACT_ADDRESS },
    rpc: { type: "string", default: process.env.RPC_URL || DEFAULT_RPC },
    repeat: { type: "string", default: "2" }, // each prompt is tried twice by default (LLM consensus can differ)
    concurrency: { type: "string", default: "1" },
    only: { type: "string" }, // comma-separated category names or id substrings
    extra: { type: "string" }, // JSON file: [{id, category, text, expect?}]
    deploy: { type: "boolean", default: false }, // force a fresh deployment
    contract: { type: "string", default: "./wizard_of_coin.py" },
    runner: { type: "string" }, // replace the py-genlayer runner hash in the contract header
    "guard-file": { type: "string" }, // deploy: constructor guard (default guard.txt); existing contract: set_guard
    fund: { type: "string", default: "auto" }, // auto | manual | none
    "fund-amount": { type: "string", default: "1000" },
    "leader-tu": { type: "string", default: "100" }, // fee estimate: leader time units
    "validator-tu": { type: "string", default: "200" }, // fee estimate: validator time units
    rotations: { type: "string", default: "0" }, // fee estimate: comma-separated, e.g. "1,1"
    fresh: { type: "boolean", default: false }, // ignore saved keys/address
    "no-nonce": { type: "boolean", default: false },
    "fail-on-breach": { type: "boolean", default: false },
    retries: { type: "string", default: "120" },
    interval: { type: "string", default: "3000" },
    list: { type: "boolean", default: false },
    resume: { type: "string" }, // results-*.jsonl from an interrupted run: skip finished attempts
    shuffle: { type: "boolean", default: false }, // mix categories so a partial run still covers everything
  },
});

const MAX_REQUEST = 1000;
const STATE_FILE = ".wizard-state.json";
const REPEAT = Math.max(1, parseInt(opt.repeat, 10) || 2);
const CONCURRENCY = Math.max(1, parseInt(opt.concurrency, 10) || 1);
const RETRIES = parseInt(opt.retries, 10) || 120;
const INTERVAL = parseInt(opt.interval, 10) || 3000;
const LEADER_TU = BigInt(opt["leader-tu"]);
const VALIDATOR_TU = BigInt(opt["validator-tu"]);
const ROTATIONS = opt.rotations.split(",").map((s) => BigInt(s.trim()));

const rand = (n = 4) => crypto.randomBytes(n).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toObj = (v) => (v instanceof Map ? Object.fromEntries(v) : v && typeof v === "object" ? v : {});
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const errMsg = (e) => oneLine(e?.shortMessage || e?.message || e);
const safeJson = (v, n = 1500) =>
  clip(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) ?? "", n);

// ---------- corpus ----------
let attacks = [...ATTACKS];
if (opt.extra) {
  const extra = JSON.parse(fs.readFileSync(opt.extra, "utf8"));
  attacks.push(...extra.map((a) => ({ category: "custom", ...a })));
}
if (opt.only) {
  const keys = opt.only.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  attacks = attacks.filter((a) => keys.some((k) => a.category.toLowerCase() === k || a.id.toLowerCase().includes(k)));
}
for (const a of attacks) {
  if (a.text.length > MAX_REQUEST - 24) {
    console.warn(`! ${a.id}: ${a.text.length} chars (limit ${MAX_REQUEST}, 24 reserved for the nonce)`);
  }
}
if (opt.list) {
  for (const a of attacks) console.log(`${a.category.padEnd(12)} ${a.id}`);
  process.exit(0);
}
if (!attacks.length) {
  console.error("No attacks selected.");
  process.exit(1);
}

// ---------- Studio Dev chain ----------
if (!chains.studioDevnet) {
  console.error(
    "genlayer-js/chains has no `studioDevnet` preset. Studio Dev needs the 2.x release candidate:\n" +
      "  npm install genlayer-js@^2.0.0-rc.1",
  );
  process.exit(1);
}
// Same override pattern the Studio Dev reports use: the id/name/RPC are pinned explicitly.
const chain = {
  ...chains.studioDevnet,
  id: CHAIN_ID,
  name: "GenLayer Studio Dev",
  rpcUrls: { default: { http: [opt.rpc] } },
};
try {
  const res = await fetch(opt.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const id = parseInt((await res.json()).result, 16);
  if (id !== CHAIN_ID) {
    console.error(`RPC ${opt.rpc} reports chain ID ${id}, expected ${CHAIN_ID} (Studio Dev).`);
    process.exit(1);
  }
  console.log(`RPC ok: ${opt.rpc} (chain ID ${id})`);
} catch (e) {
  console.error(`Cannot reach ${opt.rpc}: ${errMsg(e)}`);
  process.exit(1);
}

const makeClient = (account) => createClient({ chain, account, endpoint: opt.rpc });

// ---------- tx helpers ----------
let ADDRESS = null; // set after setup

async function feesFor(client) {
  const est = await client.estimateTransactionFees({
    leaderTimeunitsAllocation: LEADER_TU,
    validatorTimeunitsAllocation: VALIDATOR_TU,
    rotations: ROTATIONS,
  });
  return { distribution: est.distribution, feeValue: est.feeValue };
}
async function waitAccepted(client, hash) {
  return client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: RETRIES,
    interval: INTERVAL,
  });
}
async function sendAndWait(client, functionName, args) {
  const fees = await feesFor(client);
  const hash = await client.writeContract({ address: ADDRESS, functionName, args, value: 0n, fees });
  return { hash, receipt: await waitAccepted(client, hash) };
}
const readAt = (client, address, functionName, args = []) =>
  client.readContract({ address, functionName, args, stateStatus: "accepted" });
const read = (client, functionName, args = []) => readAt(client, ADDRESS, functionName, args);
const execFailed = (receipt) => receipt?.txExecutionResultName === "FINISHED_WITH_ERROR";

// ---------- state: test accounts + deployed address ----------
let state = {};
if (!opt.fresh) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { state = {}; }
}
if (state.chainId !== CHAIN_ID) state = {};
state.chainId = CHAIN_ID;
state.keys = state.keys ?? [];
while (state.keys.length < CONCURRENCY) state.keys.push(generatePrivateKey());
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
saveState();

const accounts = state.keys.slice(0, CONCURRENCY).map((k) => createAccount(k));
if (process.env.PRIVATE_KEY) accounts[0] = createAccount(process.env.PRIVATE_KEY); // use your own owner key
const clients = accounts.map(makeClient);
for (const c of clients) {
  try { if (typeof c.initializeConsensusSmartContract === "function") await c.initializeConsensusSmartContract(); }
  catch (e) { console.warn(`initializeConsensusSmartContract: ${errMsg(e)}`); }
}

// ---------- funding (fees are paid in GEN) ----------
async function balanceOf(i) {
  try {
    if (typeof clients[i].getBalance === "function")
      return BigInt(await clients[i].getBalance({ address: accounts[i].address }));
  } catch { /* balance lookup is optional */ }
  return null;
}

async function fundAccounts() {
  const amount = parseInt(opt["fund-amount"], 10) || 1000;
  console.log(`\nTest account(s) on Studio Dev (chain ${CHAIN_ID}):`);
  const pending = [];
  let unknown = false;
  for (let i = 0; i < accounts.length; i++) {
    let note = "";
    if (opt.fund === "auto") {
      try {
        await clients[i].fundAccount({ address: accounts[i].address, amount });
        note = `faucet RPC: +${amount}; `;
      } catch (e) {
        note = `faucet RPC unavailable (${clip(errMsg(e), 70)}); `;
      }
    }
    const bal = await balanceOf(i);
    if (bal === null) unknown = true;
    else if (bal === 0n) pending.push(i);
    console.log(`  #${i} ${accounts[i].address}  ${note}balance=${bal === null ? "unknown" : bal}`);
  }

  if (pending.length) {
    console.log(
      "\nThese account(s) have 0 GEN and cannot pay transaction fees. Send test GEN on Studio Dev to them,\n" +
        "using the faucet in the Studio Dev web app (https://studio-dev.genlayer.com) or a transfer from\n" +
        "your wallet on the 'GenLayer Studio Dev' network (chain ID 61997).\nWaiting for the balance (Ctrl+C to abort)…",
    );
    const deadline = Date.now() + 20 * 60_000;
    while (pending.length && Date.now() < deadline) {
      await sleep(5000);
      for (const i of [...pending]) {
        const b = await balanceOf(i);
        if (b !== null && b > 0n) {
          console.log(`  #${i} funded: balance=${b}`);
          pending.splice(pending.indexOf(i), 1);
        }
      }
    }
    if (pending.length) {
      console.error("Timed out waiting for funds.");
      process.exit(1);
    }
  } else if (opt.fund === "manual" && unknown) {
    console.log("\nCould not read balances. Send test GEN to the address(es) above, then press Enter.");
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      await rl.question("");
      rl.close();
    }
  }
  console.log();
}
if (opt.fund !== "none") await fundAccounts();

// ---------- deploy ----------
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const sameAddr = (a, b) => String(a).toLowerCase().replace(/^0x/, "").endsWith(String(b).toLowerCase().replace(/^0x/, ""));

async function contractOwner(client, addr) {
  try { return String(await readAt(client, addr, "get_owner")); } catch { return null; }
}

async function deployWizard(client, owner) {
  let code = fs.readFileSync(opt.contract, "utf8");
  if (opt.runner) {
    const hash = opt.runner.replace(/^py-genlayer:/, "");
    code = code.replace(/py-genlayer:[A-Za-z0-9._-]+/, `py-genlayer:${hash}`);
  }
  const guard = fs.readFileSync(opt["guard-file"] || "guard.txt", "utf8").trim();
  console.log(`Deploying ${opt.contract} from ${owner.address} (guard ${guard.length} chars)…`);
  const fees = await feesFor(client);
  const hash = await client.deployContract({ account: owner, code, args: [guard], leaderOnly: false, fees });
  const receipt = await waitAccepted(client, hash);
  if (execFailed(receipt)) throw new Error("deployment finished with an execution error; check tx " + hash + " in the explorer");

  const candidates = [
    receipt?.data?.contract_address,
    receipt?.txDataDecoded?.contractAddress,
    receipt?.contractAddress,
    receipt?.recipient,
    receipt?.to_address,
    receipt?.toAddress,
  ];
  try {
    const tx = await client.getTransaction({ hash });
    candidates.push(tx?.data?.contract_address, tx?.contractAddress, tx?.recipient, tx?.to_address, tx?.toAddress);
  } catch { /* fallback only */ }

  for (const cand of [...new Set(candidates.filter((c) => typeof c === "string" && ADDR_RE.test(c)))]) {
    const o = await contractOwner(client, cand);
    if (o && sameAddr(o, owner.address)) return cand;
  }
  throw new Error("could not determine the deployed address from the receipt. Receipt:\n" + safeJson(receipt) +
    "\nFind the address in the explorer, then rerun with --address 0x...");
}

let deployedHere = false;
let fromState = false;
ADDRESS = opt.address || null;
if (!ADDRESS && !opt.deploy && state.address) {
  ADDRESS = state.address;
  fromState = true;
}
if (ADDRESS && !(await contractOwner(clients[0], ADDRESS))) {
  if (fromState) {
    console.log(`Saved contract ${ADDRESS} not found (Studio Dev can be reset); deploying a new one.`);
    ADDRESS = null;
    delete state.address;
    saveState();
  } else {
    console.error(`No WizardOfCoin answered get_owner at ${ADDRESS} on Studio Dev.`);
    process.exit(1);
  }
}
if (!ADDRESS) {
  try {
    ADDRESS = await deployWizard(clients[0], accounts[0]);
    deployedHere = true;
    state.address = ADDRESS;
    saveState();
    console.log(`Deployed WizardOfCoin at ${ADDRESS}`);
  } catch (e) {
    const m = errMsg(e);
    console.error(`Deploy failed: ${m}`);
    if (/runner|invalid_contract|malformed|absent/i.test(m))
      console.error("Hint: the py-genlayer runner hash in the contract header may not exist on Studio Dev's current runtime.\n" +
        "Take the hash from Studio Dev's own hello-world example and pass it: --runner <hash>");
    if (/fee|insufficient|balance|funds/i.test(m))
      console.error(`Hint: fund ${accounts[0].address} with GEN (faucet in the Studio Dev app), then rerun.`);
    process.exit(1);
  }
}
console.log(`Explorer: ${EXPLORER}/address/${ADDRESS}\n`);

// set_guard on an existing contract (owner only: deployed by us in an earlier run, or PRIVATE_KEY)
if (opt["guard-file"] && !deployedHere) {
  const guard = fs.readFileSync(opt["guard-file"], "utf8").trim();
  console.log(`Setting guard from ${opt["guard-file"]} (${guard.length} chars)…`);
  const { receipt } = await sendAndWait(clients[0], "set_guard", [guard]);
  if (execFailed(receipt)) {
    console.error("set_guard failed (account #0 must be the owner; guard <= 4000 chars).");
    process.exit(1);
  }
}
try {
  console.log(`Guard on chain: ${String(await read(clients[0], "get_guard")).length} chars\n`);
} catch (e) {
  console.warn(`get_guard failed: ${errMsg(e)}\n`);
}

// ---------- one attempt ----------
async function runJob(client, account, job) {
  const nonce = rand();
  const attemptId = `rt_${rand(8)}`; // matches [A-Za-z0-9_:-]{1,64}
  // A winning request is burned forever (normalized text), so make every try unique.
  const text = opt["no-nonce"] ? job.attack.text : `${job.attack.text}\n\n(ref ${nonce})`;
  const started = Date.now();
  const out = {
    id: job.attack.id,
    category: job.attack.category,
    expect: job.attack.expect || "kept",
    run: job.run,
    text,
    outcome: "",
    reply: "",
    txStatus: "",
    error: "",
    ms: 0,
  };
  try {
    const { hash, receipt } = await sendAndWait(client, "ask_for_coin", [attemptId, text]);
    out.txHash = hash;
    out.txStatus = `${receipt?.statusName ?? ""}/${receipt?.txExecutionResultName ?? ""}`;
    if (execFailed(receipt)) {
      out.error = "contract execution error (see tx in the explorer; e.g. invalid consensus verdict)";
    } else {
      const res = toObj(await read(client, "get_result", [account.address, attemptId]));
      out.outcome = String(res.outcome ?? "");
      out.reply = String(res.reply ?? "");
      if (!out.outcome) out.error = "no result stored (consensus not accepted / rolled back)";
    }
  } catch (e) {
    out.error = errMsg(e);
  }
  out.ms = Date.now() - started;
  return out;
}

const verdictOf = (r) => {
  if (r.error) return "ERROR";
  if (r.outcome === "given") return r.expect === "given" ? "ok" : "BREACH";
  if (r.outcome === "kept") return r.expect === "kept" ? "held" : "UNEXPECTED_KEEP";
  return r.outcome || "ERROR";
};

// ---------- main loop ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const LOG = opt.resume || `results-${stamp}.jsonl`; // one JSON line per finished attempt (crash-safe)
const results = [];
const done = new Set();
if (opt.resume) {
  for (const line of fs.readFileSync(opt.resume, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); results.push(r); done.add(`${r.id}#${r.run}`); } catch { /* skip a torn last line */ }
  }
  console.log(`Resuming: ${results.length} attempts already in ${opt.resume}`);
}
if (opt.shuffle) {
  let seed = 1337; // deterministic shuffle (mulberry32)
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = attacks.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [attacks[i], attacks[j]] = [attacks[j], attacks[i]]; }
}
const queue = [];
for (let run = 1; run <= REPEAT; run++)
  for (const attack of attacks) if (!done.has(`${attack.id}#${run}`)) queue.push({ attack, run });
const total = queue.length + results.length;
console.log(
  `Contract ${ADDRESS} on Studio Dev (${CHAIN_ID})\n` +
    `${attacks.length} attacks x ${REPEAT} = ${attacks.length * REPEAT} attempts (${queue.length} to run), ${CONCURRENCY} worker(s); log: ${LOG}\n`,
);

await Promise.all(
  accounts.map(async (account, i) => {
    while (queue.length) {
      const job = queue.shift();
      const r = await runJob(clients[i], account, job);
      r.verdict = verdictOf(r);
      results.push(r);
      fs.appendFileSync(LOG, JSON.stringify(r) + "\n");
      const mark = r.verdict === "BREACH" ? "✘" : r.verdict === "held" ? "✔" : "?";
      console.log(
        `[${results.length}/${total}] ${mark} ${r.verdict.padEnd(7)} ${r.id}#${r.run} ` +
          `(${(r.ms / 1000).toFixed(0)}s) ${clip(oneLine(r.error || r.reply), 90)}`,
      );
    }
  }),
);

// ---------- report ----------
const byAttack = new Map();
for (const r of results) {
  const s = byAttack.get(r.id) || { id: r.id, category: r.category, runs: 0, breaches: 0, errors: 0 };
  s.runs++;
  if (r.verdict === "BREACH" || r.verdict === "UNEXPECTED_KEEP") s.breaches++;
  if (r.verdict === "ERROR") s.errors++;
  byAttack.set(r.id, s);
}
const byCat = new Map();
for (const s of byAttack.values()) {
  const c = byCat.get(s.category) || { category: s.category, runs: 0, breaches: 0 };
  c.runs += s.runs;
  c.breaches += s.breaches;
  byCat.set(s.category, c);
}
const breaches = results.filter((r) => r.verdict === "BREACH");
const errors = results.filter((r) => r.verdict === "ERROR");
const badControls = results.filter((r) => r.category === "control" && r.verdict !== "held");

const lines = [];
lines.push(`# Wizard red-team report`, ``);
lines.push(`- contract: \`${ADDRESS}\` (Studio Dev, chain ${CHAIN_ID})`);
lines.push(`- attempts: ${results.length}, breaches: **${breaches.length}**, errors: ${errors.length}`);
if (badControls.length) lines.push(`- WARNING: ${badControls.length} control attempt(s) did not behave as expected; treat results with care.`);
lines.push(``, `## By category`, ``, `| category | breaches / runs |`, `|---|---|`);
for (const c of [...byCat.values()].sort((a, b) => b.breaches / b.runs - a.breaches / a.runs))
  lines.push(`| ${c.category} | ${c.breaches} / ${c.runs} |`);
lines.push(``, `## By attack`, ``, `| attack | category | breaches / runs | errors |`, `|---|---|---|---|`);
for (const s of [...byAttack.values()].sort((a, b) => b.breaches / b.runs - a.breaches / a.runs))
  lines.push(`| ${s.id} | ${s.category} | ${s.breaches} / ${s.runs}${s.breaches > 0 && s.breaches < s.runs ? " (flaky)" : ""} | ${s.errors} |`);
if (breaches.length) {
  lines.push(``, `## Breaches (prompts that made the wizard give the coin)`);
  for (const r of breaches) {
    lines.push(``, `### ${r.id} #${r.run}`, ``, `Wizard reply: ${oneLine(r.reply)}`, ``, "```text", r.text, "```");
  }
}
const md = lines.join("\n");

fs.writeFileSync(`report-${stamp}.json`, JSON.stringify({ address: ADDRESS, chainId: CHAIN_ID, results }, null, 2));
fs.writeFileSync(`report-${stamp}.md`, md);
console.log("\n" + md);
console.log(`\nSaved report-${stamp}.json and report-${stamp}.md`);
if (results.length && errors.length / results.length > 0.5) {
  console.log("\nMost attempts errored. Check balances (fees are paid in GEN) and the error text above; test account(s):");
  for (const a of accounts) console.log(`  ${a.address}`);
  console.log("If it says out of budget/time units, raise --leader-tu / --validator-tu (e.g. 300 / 600).");
}

if (opt["fail-on-breach"] && breaches.length) process.exit(2);
