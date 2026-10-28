// BSC 链上新合约扫描：找「免费可铸」的 ERC721（mint() 模拟成功 = 能白嫖）
// 用法: node tools/bsc-nft-scanner.mjs [--once] [--blocks 150] [--dry]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry");
const MAXBLOCKS = Number(arg("--blocks", "150"));
const DIR = path.resolve(".dsh/nftscan");
fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(DIR, "state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { lastBlock: 0, checked: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");

const tg = JSON.parse(fs.readFileSync(".dsh/tg-main.json", "utf8"));
const WALLET = "0x18D71d34267697FEDf23210a87A7959e42C98792";
const RPC = "https://bsc-dataseed.binance.org";
const BAW_ENV = { ...process.env, HTTPS_PROXY: "http://127.0.0.1:12450", HTTP_PROXY: "http://127.0.0.1:12450", NODE_USE_ENV_PROXY: "1" };

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
async function notify(text) {
  if (DRY) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { log(`tg 失败 ${e.message}`); }
}
let rpcId = 0;
async function rpc(method, params) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j.error) return null;
      return j.result;
    } catch { await new Promise((r) => setTimeout(r, 800)); }
  }
  return null;
}
const int = (h) => (h && h !== "0x" ? parseInt(h, 16) : null);
const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

function bawJson(args, timeout = 120000) {
  const r = spawnSync("baw", args, { encoding: "utf8", env: BAW_ENV, timeout, shell: true });
  const out = (r.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) throw new Error((r.stderr || out || "no output").slice(0, 120));
  return JSON.parse(out.slice(i));
}

async function main() {
  const bnHex = await rpc("eth_blockNumber", []);
  const latest = int(bnHex);
  if (!latest) { log("拿不到区块高度"); return; }
  if (!state.lastBlock) state.lastBlock = latest - MAXBLOCKS;
  const from = Math.max(state.lastBlock + 1, latest - MAXBLOCKS);
  if (from > latest) { log("无新区块"); return; }
  log(`扫描区块 ${from} → ${latest}（${latest - from + 1} 个）`);

  const numbers = [];
  for (let n = from; n <= latest; n++) numbers.push("0x" + n.toString(16));
  const creations = [];
  for (let i = 0; i < numbers.length; i += 8) {
    const chunk = numbers.slice(i, i + 8);
    const blocks = await Promise.all(chunk.map((n) => rpc("eth_getBlockByNumber", [n, true])));
    for (const b of blocks) {
      if (!b?.transactions) continue;
      for (const t of b.transactions) {
        if (t.to === null || t.to === undefined) creations.push({ hash: t.hash, from: t.from });
      }
    }
  }
  state.lastBlock = latest;
  log(`发现新合约创建交易 ${creations.length} 个`);
  if (!creations.length) { save(); return; }

  // 取合约地址
  const addrs = [];
  for (const c of creations.slice(0, 60)) {
    const rc = await rpc("eth_getTransactionReceipt", [c.hash]);
    if (rc?.contractAddress) addrs.push(rc.contractAddress);
  }
  log(`有效合约地址 ${addrs.length} 个`);

  let skipped = 0;
  for (const a of addrs) {
    const key = a.toLowerCase();
    if (state.checked[key]) continue;
    const erc721 = int(await call(a, "0x01ffc9a780ac58cd" + "0".repeat(56)));
    state.checked[key] = { erc721: erc721 === 1, at: Date.now() };
    if (erc721 !== 1) { skipped++; continue; }
    const total = int(await call(a, "0x18160ddd"));
    const maxSup = int(await call(a, "0xd5abeb01"));
    const bal = int(await call(a, "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase()));
    const owner = await call(a, "0x8da5cb5b");
    const symbol = await call(a, "0x95d89b41");
    log(`🎯 ERC721 新合约 ${a} total=${total} max=${maxSup} bal=${bal} owner=${owner ? "有" : "无"}`);
    if (bal && bal > 0) { log("  已持有，跳过"); continue; }
    if (maxSup != null && total != null && maxSup - total <= 0) { log("  已满，跳过"); continue; }

    // 模拟 mint()，成功 = 免费可铸
    let mintable = null;
    try {
      const prev = bawJson(["contract-call", "preview", "--binanceChainId", "56", "--from", WALLET,
        "--to", a, "--value", "0", "--inputData", "0xa0712d68", "--json"]);
      mintable = prev.success && (!prev.data?.simulationResult?.simulationCode || prev.data.simulationResult.simulationCode === "000000000");
    } catch (e) { mintable = false; log(`  模拟异常 ${String(e.message).slice(0, 80)}`); }

    if (!mintable) { log("  mint() 模拟失败（收费/无权限/已满）"); continue; }

    state.checked[key].mintable = true;
    if (DRY) { await notify(`🧪 (DRY) 可免费铸造\n${a}\n供应 ${total}/${maxSup ?? "?"}`); continue; }
    try {
      const prev = bawJson(["contract-call", "preview", "--binanceChainId", "56", "--from", WALLET,
        "--to", a, "--value", "0", "--inputData", "0xa0712d68", "--json"]);
      const reqId = prev.data?.requestId;
      const ex = bawJson(["contract-call", "execute", "--requestId", reqId, "--json"], 150000);
      if (ex.success) {
        state.checked[key].minted = ex.data?.txHash;
        await notify(`✅ 免费 NFT 铸造成功\n${a}\n供应 ${total}/${maxSup ?? "?"}\ntxHash ${ex.data?.txHash}`);
      } else {
        await notify(`⚠️ 铸造失败\n${a}\n${JSON.stringify(ex.error || {}).slice(0, 120)}`);
      }
    } catch (e) {
      await notify(`⚠️ 铸造异常\n${a}\n${String(e.message).slice(0, 120)}`);
    }
  }
  if (skipped) log(`非 ERC721 跳过 ${skipped} 个`);
  save();
}

log(`BSC 新 NFT 扫描启动（每轮最多 ${MAXBLOCKS} 块，自动 mint）${DRY ? " [DRY]" : ""}`);
do {
  try { await main(); } catch (e) { log(`main 异常 ${e.message}`); }
  if (!ONCE) await new Promise((r) => setTimeout(r, 60 * 1000));
} while (!ONCE);
