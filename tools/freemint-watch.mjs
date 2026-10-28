// 免费铸造监控：The Colony #free-mint / #agent-id 新帖 → 链上验证 → Telegram 通知（不自动 mint）
// 用法: node tools/freemint-watch.mjs [--once]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIR = path.resolve(".dsh/freemint");
const STATE = path.join(DIR, "state.json");
fs.mkdirSync(DIR, { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { seenPosts: {}, checked: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");

const tg = JSON.parse(fs.readFileSync(".dsh/tg-main.json", "utf8"));
const WALLET = "0x18D71d34267697FEDf23210a87A7959e42C98792";
const RPC = "https://bsc-dataseed.binance.org";
const TAGS = ["free-mint", "agent-id", "nft", "bnb-chain"];
const ONCE = process.argv.includes("--once");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
async function notify(text) {
  try {
    await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { log(`tg 失败 ${e.message}`); }
}

const get = async (url) => (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25000) })).text();
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

async function ethCall(to, data) {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j.error) return null;
    return j.result;
  } catch { return null; }
}
const hexToInt = (h) => (h && h !== "0x" ? parseInt(h, 16) : null);

async function verify(addr) {
  // ERC721 检查：supportsInterface(0x80ac58cd)
  const erc721 = await ethCall(addr, "0x01ffc9a780ac58cd" + "0".repeat(56));
  const isERC721 = erc721 && erc721 !== "0x" && hexToInt(erc721) === 1;
  const total = hexToInt(await ethCall(addr, "0x18160ddd"));
  const bal = hexToInt(await ethCall(addr, "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase()));
  const maxSup = hexToInt(await ethCall(addr, "0xd5abeb01")); // maxSupply()
  const owner = await ethCall(addr, "0x8da5cb5b");
  const price = hexToInt(await ethCall(addr, "0x6817c76c"));  // mintPrice() ? 可能不存在
  return {
    isERC721: !!isERC721,
    totalSupply: total, maxSupply: maxSup, walletBalance: bal,
    hasOwner: owner !== null && owner !== "0x" + "0".repeat(64),
    ownerAddr: owner && owner !== "0x" + "0".repeat(64) ? "0x" + owner.slice(-40) : null,
    mintPriceWei: price,
    checkedAt: Date.now(),
  };
}

async function scan() {
  const posts = new Set();
  for (const tag of TAGS) {
    try {
      const html = await get(`https://thecolony.cc/tags/${tag}`);
      for (const m of html.matchAll(/href="(\/post\/[a-f0-9-]{36})"/g)) posts.add(m[1]);
    } catch (e) { log(`tag ${tag} 抓取失败 ${e.message}`); }
  }
  // 聪哥 TG 频道：直接给合约 + 规则
  const tgAddrs = new Set();
  try {
    const html = await get("https://t.me/s/conggealpha");
    for (const b of html.split('data-post="').slice(1)) {
      const seg = b.slice(0, 6000);
      const txt = (seg.match(/<div class="tgme_widget_message_text[^"]*" dir="auto">([\s\S]*?)<\/div>/) || [])[1];
      if (!txt) continue;
      const text = strip(txt);
      for (const a of text.match(/0x[a-fA-F0-9]{40}/g) || []) tgAddrs.add(a);
    }
    log(`聪哥频道合约 ${tgAddrs.size} 个`);
  } catch (e) { log(`聪哥频道抓取失败 ${e.message}`); }
  for (const a of tgAddrs) {
    const k = a.toLowerCase();
    if (state.checked[k]?.freemintDone) continue;
    log(`聪哥信号合约 ${a} → 执行免费铸造`);
    const r = spawnSync(process.execPath, ["tools/freemint-exec.mjs", "--token", a, "--max", "3"], {
      encoding: "utf8", cwd: process.cwd(), timeout: 240000,
      env: { ...process.env, HTTPS_PROXY: "http://127.0.0.1:12450", HTTP_PROXY: "http://127.0.0.1:12450", NODE_USE_ENV_PROXY: "1" },
    });
    const out = (r.stdout || "") + (r.stderr || "");
    log(out.split("\n").filter((l) => l.includes("✅") || l.includes("失败") || l.includes("停止")).join(" | ").slice(0, 400));
    state.checked[k] = { ...(state.checked[k] || {}), freemintDone: Date.now() };
  }
  const fresh = [...posts].filter((p) => !state.seenPosts[p]);
  log(`发现 ${posts.size} 个帖子，新增 ${fresh.length}`);
  for (const p of fresh) {
    state.seenPosts[p] = Date.now();
    let text = "";
    try { text = strip(await get("https://thecolony.cc" + p)); } catch { continue; }
    const addrs = [...new Set([...text.matchAll(/0x[a-fA-F0-9]{40}/g)].map((m) => m[0]))];
    if (!addrs.length) continue;
    const title = (text.slice(0, 200) || "").trim();
    for (const a of addrs) {
      if (state.checked[a.toLowerCase()]?.reported) continue;
      const v = await verify(a);
      if (!v.isERC721) { log(`  ${a} 不是 ERC721，跳过`); continue; }
      if (v.totalSupply === null) { log(`  ${a} 读不到 totalSupply，跳过`); continue; }
      const left = v.maxSupply != null && v.totalSupply != null ? v.maxSupply - v.totalSupply : null;
      const already = v.walletBalance && v.walletBalance > 0;
      state.checked[a.toLowerCase()] = { ...v, reported: true, source: p };
      log(`合约 ${a} total=${v.totalSupply} max=${v.maxSupply} left=${left} 已持有=${already}`);
      if (already) continue;
      if (left !== null && left <= 0) { log(`  → 已铸完，跳过`); continue; }
      // 自动 mint（用户授权：不再询问）
      const r = await tryMint(a);
      if (r.ok) {
        await notify(`✅ 免费 NFT 铸造成功\n${a}\n总供应 ${v.totalSupply}/${v.maxSupply ?? "?"}\ntxHash ${r.txHash}\n(gas 自付，mint 价格 0)`);
        state.checked[a.toLowerCase()].minted = r.txHash;
      } else {
        await notify(`⚠️ 免费 NFT 铸造失败\n${a}\n原因：${r.reason}\n仍需人工判断`);
      }
    }
  }
  save();
}

// ---- 自动 mint：mint() 选择器 0xa0712d68，value 0 ----
const BAW_ENV = { ...process.env, HTTPS_PROXY: "http://127.0.0.1:12450", HTTP_PROXY: "http://127.0.0.1:12450", NODE_USE_ENV_PROXY: "1" };
function bawJson(args, timeout = 120000) {
  const r = spawnSync("baw", args, { encoding: "utf8", env: BAW_ENV, timeout, shell: true });
  const out = (r.stdout || "").trim();
  const i = out.indexOf("{");
  if (i < 0) throw new Error((r.stderr || out || "no output").slice(0, 120));
  return JSON.parse(out.slice(i));
}

async function tryMint(addr) {
  try {
    const prev = bawJson(["contract-call", "preview", "--binanceChainId", "56",
      "--from", WALLET, "--to", addr, "--value", "0", "--inputData", "0xa0712d68", "--json"]);
    if (!prev.success) return { ok: false, reason: JSON.stringify(prev.error || {}).slice(0, 120) };
    const reqId = prev.data?.requestId;
    const sim = prev.data?.simulationResult?.simulationCode;
    if (!reqId) return { ok: false, reason: "无 requestId" };
    if (sim && sim !== "000000000") return { ok: false, reason: `模拟失败 ${sim}` };
    const ex = bawJson(["contract-call", "execute", "--requestId", reqId, "--json"], 150000);
    if (ex.success) return { ok: true, txHash: ex.data?.txHash };
    return { ok: false, reason: JSON.stringify(ex.error || {}).slice(0, 120) };
  } catch (e) {
    return { ok: false, reason: String(e.message).slice(0, 140) };
  }
}

log("免费铸造监控启动（自动 mint，间隔 60 秒）");
do {
  try { await scan(); } catch (e) { log(`scan 异常 ${e.message}`); }
  if (!ONCE) await new Promise((r) => setTimeout(r, 60 * 1000));
} while (!ONCE);
