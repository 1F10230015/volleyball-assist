import { useState, useEffect, useRef, useMemo } from "react";

// ====== モメンタム計算 ======
const ALPHA = 0.72;
const M_MIN = -5, M_MAX = 5;
const CANDIDATE_THRESHOLD = 2.2;
const LOCAL_ALERT_THRESHOLD = 3.4;
const SET_TARGET = 25; // デフォルトの先取点数(セットごとに15点制などへ変更可能)
const WIN_BY = 2;
const MAX_TIMEOUTS = 2;

// ====== ポジション構成(両チーム共通) ======
const POSITIONS = ["レフト", "レフト", "ライト", "セッター", "センター", "センター"];
const defaultRoster = () => ({
  us: POSITIONS.map((pos, i) => ({ pos, name: `選手${"ABCDEF"[i]}` })),
  them: POSITIONS.map((pos, i) => ({ pos, name: `相手${"ABCDEF"[i]}` })),
});
// ★対角ルール: P1-P4 / P2-P5 / P3-P6 が対角(レフト⇔レフト、センター⇔センター、セッター⇔ライト)
// P1=レフトA(0), P2=セッターD(3), P3=センターE(4), P4=レフトB(1), P5=ライトC(2), P6=センターF(5)
const DIAGONAL_LINEUP = [0, 3, 4, 1, 2, 5];
const defaultLineup = () => ({ us: [...DIAGONAL_LINEUP], them: [...DIAGONAL_LINEUP] });

const PLAYS = {
  win: [
    { id: "spike", label: "スパイク", emoji: "💥", w: 1.0 },
    { id: "ace", label: "サーブエース", emoji: "🎯", w: 2.0, autoServer: "us" },
    { id: "block", label: "ブロック", emoji: "🧱", w: 1.5 },
    { id: "oppErr", label: "相手エラー", emoji: "🎁", w: 0.5 },
  ],
  lose: [
    { id: "hitBy", label: "被スパイク", emoji: "🔻", w: 1.0 },
    { id: "aceBy", label: "被サーブ", emoji: "⚡", w: 1.5, autoServer: "them" },
    { id: "blockBy", label: "被ブロック", emoji: "🚧", w: 1.2 },
    { id: "ownErr", label: "自滅エラー", emoji: "😱", w: 1.8 },
  ],
};

function targetTeamFor(pending) {
  if (pending.e === 1) return pending.play === "相手エラー" ? "them" : "us";
  return pending.play === "自滅エラー" ? "us" : "them";
}
const tKey = t => `${t.team}-${t.idx}`;

// ====== ローテーション追跡(サイドアウト制) ======
function deriveRotation(log, firstServe) {
  let serving = firstServe, us = 0, them = 0;
  for (const r of log) {
    if (r.type !== "rally") continue;
    if (r.e === 1 && serving === "them") { us++; serving = "us"; }
    else if (r.e === -1 && serving === "us") { them++; serving = "them"; }
  }
  return { serving, us, them };
}

function momentumSeries(log, toFactor = 0.45) {
  let m = 0; const series = [0];
  for (const r of log) {
    if (r.type === "timeout") m *= toFactor;
    else m = ALPHA * m + r.w * r.e;
    series.push(m);
  }
  return series;
}

function setWinner(us, them, target = SET_TARGET) {
  if (us >= target && us - them >= WIN_BY) return "us";
  if (them >= target && them - us >= WIN_BY) return "them";
  return null;
}

// ====== ★勝率予測エンジン(モンテカルロ・シミュレーション) ======
// 現スコア・モメンタム・サーブ権から残りのセット展開を300回シミュレートし、セット獲得確率を推定する。
// サーブ側/レシーブ側の得点率(サイドアウト率)は学習データがあればそれを使う。
// モメンタムの影響は平均回帰させる(勢いは永続しないという仮定)。研究上はこの仮定自体が検証対象。
function winProbSim(us, them, m, serving = "us", lp = null, target = SET_TARGET) {
  const w = setWinner(us, them, target);
  if (w === "us") return 1; if (w === "them") return 0;
  const pServe = lp?.pServe ?? 0.45, pReceive = lp?.pReceive ?? 0.55;
  let wins = 0; const N = 300, maxRallies = target * 4 + 30;
  for (let i = 0; i < N; i++) {
    let a = us, b = them, srv = serving, mShift = 0.04 * m;
    for (let g = 0; g < maxRallies; g++) {
      if (a >= target && a - b >= WIN_BY) { wins++; break; }
      if (b >= target && b - a >= WIN_BY) break;
      const p = Math.min(0.85, Math.max(0.15, (srv === "us" ? pServe : pReceive) + mShift));
      if (Math.random() < p) { a++; srv = "us"; } else { b++; srv = "them"; }
      mShift *= 0.9; // 平均回帰
    }
  }
  return wins / N;
}

// ====== 第1段階: ローカル警戒度 ======
function assessThreat(log, us, them, labelOf, toFactor = 0.45, target = SET_TARGET) {
  const series = momentumSeries(log, toFactor);
  const m = series[series.length - 1];
  const factors = [];
  let score = 0;

  const lastTO = log.map(r => r.type).lastIndexOf("timeout");
  const since = (lastTO === -1 ? log : log.slice(lastTO + 1)).filter(r => r.type === "rally");
  let streak = 0;
  for (let i = since.length - 1; i >= 0; i--) { if (since[i].e === -1) streak++; else break; }
  if (streak >= 2) {
    const v = streak === 2 ? 1.2 : 2.4 + (streak - 3) * 1.0;
    score += v; factors.push({ label: `${streak}連続失点`, v });
  }
  const tail = since.slice(-3);
  if (tail.length === 3 && tail.every(r => r.e === -1 && tKey(r.target) === tKey(tail[0].target))) {
    score += 1.0; factors.push({ label: `${labelOf(tail[0].target)}に繰り返し攻略されている`, v: 1.0 });
  }
  const k = Math.min(4, series.length - 1);
  const dM = m - series[series.length - 1 - k];
  if (dM < -0.8) {
    const v = Math.min(2.0, -dM * 0.7);
    score += v; factors.push({ label: "流れが急降下中", v });
  }
  if (m < -1.5) {
    const v = Math.min(1.5, (-m - 1.5) * 0.6);
    score += v; factors.push({ label: "モメンタムが劣勢圏", v });
  }
  const lead = us - them;
  if (lead > 0) {
    const v = -Math.min(2.5, lead * 0.35);
    score += v; factors.push({ label: `${lead}点リード中(余裕あり)`, v });
  } else if (lead < -3) {
    const v = Math.min(1.2, -lead * 0.15);
    score += v; factors.push({ label: `${-lead}点ビハインド`, v });
  }
  const endgame = Math.max(us, them) >= target - 5;
  if (endgame && Math.abs(lead) <= 3) {
    const v = score > 0 ? score * 0.35 : 0.8;
    score += v; factors.push({ label: "セット終盤の競り合い", v });
  }
  if (us >= target - 1 && them >= target - 1) {
    score += 1.2; factors.push({ label: "デュース突入(1本の重みが最大)", v: 1.2 });
  } else if (them >= target - 4 && lead < 0) {
    score += 1.0; factors.push({ label: "相手がセットポイント圏に接近", v: 1.0 });
  }
  return { score: Math.max(0, score), factors, streak, m, dM, lead };
}

// ====== 第2段階: LLM最終判定 ======
async function judgeWithLLM(ctx) {
  const ralliesTxt = ctx.recent.map(r => `${r.e === 1 ? "得点" : "失点"}(${r.play}/${ctx.labelOf(r.target)})`).join("→");
  const prompt = `あなたはバレーボールの試合分析AI。今タイムアウトを取るべきか判定せよ。
判断基準: 先行研究では2〜3連続失点時のタイムアウトが有効。ただし大量リード中は温存が合理的、セット終盤(残り5点以内)やデュースの接戦は早めの介入が有効、TOは1セット${MAX_TIMEOUTS}回のみ、ラッキーな失点と構造的に攻略されている失点(同じ選手から等)を区別すること。セットは${ctx.target}点先取・2点差制。
状況: スコア自${ctx.us}-${ctx.them}相手 / 残TO${ctx.timeoutsLeft} / M=${ctx.m.toFixed(2)}(±5,負=劣勢) / ΔM=${ctx.dM.toFixed(2)} / 連続失点${ctx.streak}本 / セット獲得確率${Math.round(ctx.wp * 100)}% / サーブ権:${ctx.serving === "us" ? "自チーム" : "相手"}
直近: ${ralliesTxt}
${ctx.learnNote ? `学習知見(プロ・過去試合の蓄積データ統計。判定の参考にせよ): ${ctx.learnNote}\n` : ""}警戒度: ${ctx.score.toFixed(1)} (${ctx.factors.map(f => f.label).join("、")})
adviceでは選手名・ポジションを使って具体的に指示すること。
次のJSONのみ出力(前置き・フェンス禁止):
{"alert": true/false, "urgency": 1-5, "reason": "40字以内", "advice": "指示2文90字以内(falseでも声かけ案)"}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = (data.content?.map(c => c.text || "").join("") || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return typeof parsed.alert === "boolean" ? parsed : null;
  } catch { return null; }
}

function localVerdict(threat) {
  const alert = threat.score >= LOCAL_ALERT_THRESHOLD;
  return {
    alert, urgency: alert ? 4 : 2,
    reason: alert ? "警戒度が高く流れの分断が必要" : "まだ流れは戻せる範囲",
    advice: alert ? "難しいプレーは封印し、まず3本で確実に返すこと。" : "次のサーブカットを丁寧に。声を出して位置取りを確認。",
    offline: true,
  };
}

function next3Outcome(log, fromIndex) {
  const after = log.slice(fromIndex).filter(r => r.type === "rally").slice(0, 3);
  if (!after.length) return null;
  return { won: after.filter(r => r.e === 1).length, n: after.length };
}

function calibrateWeights(logs) {
  let losses = [], inRush = [];
  for (const log of logs) {
    const rallies = log.filter(r => r.type === "rally");
    losses.push(...rallies.filter(r => r.e === -1));
    let run = [];
    for (const r of rallies) {
      if (r.e === -1) run.push(r);
      else { if (run.length >= 3) inRush.push(...run); run = []; }
    }
    if (run.length >= 3) inRush.push(...run);
  }
  if (losses.length < 5 || inRush.length < 3) return [];
  const out = [];
  for (const p of PLAYS.lose) {
    const overall = losses.filter(r => r.play === p.label).length / losses.length;
    const rush = inRush.filter(r => r.play === p.label).length / inRush.length;
    if (overall > 0 && rush / overall >= 1.25 && rush > 0.2) {
      out.push({
        play: p.label, current: p.w, suggested: Math.round((p.w + 0.3) * 10) / 10,
        note: `ラッシュ中の出現率${Math.round(rush * 100)}%(通常${Math.round(overall * 100)}%)`,
      });
    }
  }
  return out;
}

async function practiceMenu(stats) {
  const prompt = `バレーボール初中級チームのコーチAI。今日の試合の弱点データから次回練習メニューを提案せよ。
弱点: ${stats}
次のJSON配列のみ出力(フェンス禁止): [{"title":"メニュー名","desc":"やり方40字以内","mins":分数}] 3件`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = (data.content?.map(c => c.text || "").join("") || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.slice(0, 3) : null;
  } catch { return null; }
}
const FALLBACK_MENU = [
  { title: "3本確実リターン", desc: "乱打で「3本で返す」だけを20本連続成功するまで", mins: 20 },
  { title: "サーブカット集中", desc: "サーバー2人で交互に打ち、レシーブ位置を毎回声出し", mins: 15 },
  { title: "連続失点シミュレーション", desc: "0-3ビハインド想定からのゲーム形式で立て直し練習", mins: 25 },
];

// ====== ★AI実況: 試合ストーリー生成 ======
async function matchStory(summary) {
  const prompt = `あなたは熱血スポーツ実況アナウンサー。アマチュアバレーの試合データから、チームが盛り上がる短い実況風ハイライト記事を書け。
データ: ${summary}
選手名を使い、ターニングポイントを劇的に描写すること。
次のJSONのみ出力(フェンス禁止): {"headline":"見出し15字以内","story":"本文200字以内"}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = (data.content?.map(c => c.text || "").join("") || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return parsed.story ? parsed : null;
  } catch { return null; }
}

// ====== ★AI学習エンジン: プロ・春高・自チームの試合記録から学習 ======
// 観戦学習モードで記録した試合やインポートしたJSONを蓄積し、
// サイドアウト率・W_t重み・TO効果・サーブ順別強さを統計学習してAI各所に適用する。
const LEARN_KEY = "vbmc_learn_v1";
function loadLearnEntries() {
  try { return JSON.parse(localStorage.getItem(LEARN_KEY)) || []; } catch { return []; }
}
function saveLearnEntries(entries) {
  try { localStorage.setItem(LEARN_KEY, JSON.stringify(entries)); } catch { /* 容量超過等は無視 */ }
}

function computeLearnedParams(entries) {
  if (!entries.length) return null;
  const logs = entries.flatMap(e => (e.sets || []).map(s => s.log || []));
  const rallies = logs.flat().filter(r => r && r.type === "rally");
  if (rallies.length < 10) return null;

  // サーブ側/レシーブ側の得点率(サイドアウト率)
  const known = rallies.filter(r => r.servingAtStart === "us" || r.servingAtStart === "them");
  let pServe = null, pReceive = null;
  if (known.length >= 30) {
    const recvWin = known.filter(r => (r.servingAtStart === "us" ? r.e === -1 : r.e === 1)).length;
    pReceive = Math.min(0.75, Math.max(0.4, recvWin / known.length));
    pServe = 1 - pReceive;
  }

  // タイムアウト効果 → モメンタム分断係数(立て直し率が高いほど強く分断)
  const outs = logs.flatMap(log =>
    log.map((r, i) => r.type === "timeout" ? i : -1).filter(i => i >= 0).map(i => next3Outcome(log, i + 1))
  ).filter(Boolean);
  const toRate = outs.length >= 3 ? outs.reduce((s, o) => s + o.won, 0) / outs.reduce((s, o) => s + o.n, 0) : null;
  const toFactor = toRate === null ? 0.45 : Math.min(0.6, Math.max(0.25, 0.6 - 0.3 * toRate));

  // W_t 重みの自動補正(失点ラッシュに偏るプレーを重く)
  const calib = calibrateWeights(logs);
  const weights = {};
  calib.forEach(c => { weights[c.play] = c.suggested; });

  // サーブ順(P1に立つ選手)別の得失点 ※自チームの試合のみ
  const byServer = Array.from({ length: 6 }, () => ({ won: 0, lost: 0 }));
  let byServerN = 0;
  entries.filter(e => e.source === "own" && e.lineup?.us).forEach(e => {
    (e.sets || []).forEach(s => (s.log || []).forEach(r => {
      if (r.type === "rally" && typeof r.rotUs === "number") {
        const idx = e.lineup.us[r.rotUs];
        if (byServer[idx]) { byServer[idx][r.e === 1 ? "won" : "lost"]++; byServerN++; }
      }
    }));
  });

  // 失点プレー内訳(レポート用)
  const lossPlays = {};
  rallies.filter(r => r.e === -1).forEach(r => { lossPlays[r.play] = (lossPlays[r.play] || 0) + 1; });

  const note = [
    `${entries.length}試合${rallies.length}ラリーから学習`,
    pServe !== null ? `サーブ時得点率${Math.round(pServe * 100)}%/レシーブ時${Math.round(pReceive * 100)}%` : null,
    toRate !== null ? `TO後3本の立て直し率${Math.round(toRate * 100)}%` : null,
    calib.length ? `連続失点の引き金: ${calib.map(c => c.play).join("・")}` : null,
  ].filter(Boolean).join(" / ");

  return { matches: entries.length, ralliesN: rallies.length, pServe, pReceive, toRate, toFactor, weights, calib, byServer, byServerN, lossPlays, note };
}

// ★AIローテ最適化: 学習したサーブ順別得失点差から、最初のサーバーを誰にすべきか探索
// (序盤ほど出現回数が多いので減衰重み付き。対角関係は保ったまま開始位置だけ回す)
function bestServeOrder(lineupUs, byServer) {
  const sc = o => {
    let s = 0;
    for (let k = 0; k < 6; k++) {
      const st = byServer[lineupUs[(o + k) % 6]];
      s += (st ? st.won - st.lost : 0) * Math.pow(0.85, k);
    }
    return s;
  };
  let best = 0;
  for (let o = 1; o < 6; o++) if (sc(o) > sc(best)) best = o;
  return { offset: best, score: sc(best), current: sc(0) };
}

// ★AI戦術レポート: 蓄積学習データの統計から次戦に向けた戦術知見を生成
async function scoutReport(summary) {
  const prompt = `あなたはバレーボールのデータアナリスト。チームが蓄積した試合学習データ(プロ・春高の観戦記録や自チームの試合)の統計サマリーから、次の試合に向けた戦術レポートを作成せよ。
データ: ${summary}
具体的で実行可能な助言にすること。精神論は禁止。
次のJSONのみ出力(フェンス禁止): {"title":"レポート題15字以内","points":["戦術ポイント60字以内","…"]} pointsは4件`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = (data.content?.map(c => c.text || "").join("") || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.points) ? parsed : null;
  } catch { return null; }
}

// ====== ★AIフォームラボ: ブラウザ内リアルタイム骨格解析(MediaPipe Pose) ======
// カメラまたは動画ファイルから33点の骨格をリアルタイム推定し、オーバーハンドスイング
// (スパイク/サーブ)を自動検出して採点する。映像は端末内で処理され、外部送信されない。
const MP_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
// 検出精度モデル(lite=軽量/full=標準/heavy=高精度)。スマホはfull推奨、heavyはPC向き
const POSE_MODELS = {
  lite: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
};
// 計測に必須のランドマーク(鼻・手首・膝・足首)。これらの可視性が低いフレームは計測除外
const KEY_VIS_POINTS = [0, 15, 16, 25, 26, 27, 28];
const SMOOTH_ALPHA = 0.55; // 骨格EMA平滑化係数(大=追従重視、小=滑らか重視)
const FORM_REF_KEY = "vbmc_form_ref_v1";
const POSE_LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];

const angleDeg = (a, b, c) => {
  const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
  const m = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1e-9;
  return Math.acos(Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / m))) * 180 / Math.PI;
};

// スイング1本の採点(満点100)。打点の高さ40 / 肘の伸び25 / 沈み込み20 / ジャンプ15
function repScore(r) {
  const c01 = v => Math.min(1, Math.max(0, v));
  return Math.round(
    c01((r.maxWristH - 0.05) / 0.2) * 40 +
    c01((r.elbowAtMax - 120) / 45) * 25 +
    c01((150 - r.minKnee) / 50) * 20 +
    c01(r.maxJump / 0.12) * 15
  );
}

function loadFormRef() {
  try { return JSON.parse(localStorage.getItem(FORM_REF_KEY)); } catch { return null; }
}

// ★お手本リスト(複数管理・ON/OFF・追加削除)
const FORM_REFS_KEY = "vbmc_form_refs_v1";
// プリセットは公開データ(石川祐希: 身長192cm・最高到達点351cm等)とエリート選手の
// 標準バイオメカニクス値からの推定。実映像を「動画ファイルを分析」→「お手本に登録」すれば実測値に置き換えられる。
const BUILTIN_REFS = [
  { id: "preset-ishikawa-spike", label: "石川祐希 スパイク", kind: "スパイク", hit: 0.44, elbow: 170, knee: 110, jump: 0.45, n: "推定", builtin: true, enabled: true },
  { id: "preset-ishikawa-jserve", label: "石川祐希 ジャンプサーブ", kind: "サーブ", hit: 0.46, elbow: 172, knee: 118, jump: 0.40, n: "推定", builtin: true, enabled: true },
];
function loadFormRefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(FORM_REFS_KEY));
    if (Array.isArray(stored)) return stored;
  } catch { /* 初回 */ }
  // 初回: プリセットを格納し、旧形式の単一お手本があれば移行
  const refs = BUILTIN_REFS.map(r => ({ ...r }));
  const old = loadFormRef();
  if (old && typeof old.hit === "number") {
    refs.forEach(r => { if (r.kind === (old.kind || "スパイク")) r.enabled = false; });
    refs.push({ id: `mig-${Date.now()}`, label: "マイお手本(移行)", kind: old.kind || "スパイク", hit: old.hit, elbow: old.elbow, knee: old.knee, jump: old.jump, n: old.n, enabled: true, savedAt: old.savedAt });
  }
  return refs;
}

// ★AIフォームコーチ: 骨格計測の統計からLLMが改善アドバイスを生成
async function formCoachLLM(summary) {
  const prompt = `あなたはバレーボールのフォーム指導コーチAI。骨格推定AIで計測したオーバーハンドスイングの統計から、具体的な改善アドバイスを作成せよ。
計測値の意味: 打点=手首が鼻より上に出た高さ(身長比%、高いほど良い) / 肘角度=インパクト時の伸展(180°が完全伸展) / 膝角度=助走時の最小値(小さいほど深く沈む) / ジャンプ=腰の上昇量(身長比%)
データ: ${summary}
体の使い方を具体的に指示すること。精神論は禁止。
次のJSONのみ出力(フェンス禁止): {"points":["アドバイス60字以内","…"]} 3件`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await res.json();
    const text = (data.content?.map(c => c.text || "").join("") || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.points) ? parsed.points : null;
  } catch { return null; }
}
const FALLBACK_FORM_TIPS = [
  "打点が低めです。トスを上げたら最高到達点で「待つ」のではなく、最高点でミートする意識でスイング開始を半テンポ遅らせましょう。",
  "肘が曲がったままミートしています。耳の横から肘を先行させ、最後に前腕を鞭のように振り出すと自然に伸びます。",
  "沈み込みが浅いとジャンプに力が乗りません。助走最後の2歩を「右・左ッ」と大きく踏み込み、膝を120°程度まで曲げてから跳びましょう。",
];

// ====== ★音声コーチ(Web Speech API) ======
function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP"; u.rate = 1.05;
    speechSynthesis.speak(u);
  } catch { /* 非対応環境は無視 */ }
}

let pid = 0;

export default function MomentumCoach() {
  const [roster, setRoster] = useState(defaultRoster);
  const [lineup, setLineup] = useState(defaultLineup);
  const [firstServe, setFirstServe] = useState("us");
  const [log, setLog] = useState([]);
  const [step, setStep] = useState(0);
  const [pending, setPending] = useState({});
  const [alert, setAlertS] = useState(null);
  const [verdict, setVerdict] = useState(null);
  const [verdicts, setVerdicts] = useState([]);
  const [judging, setJudging] = useState(false);
  const [timeout_, setTimeoutS] = useState(null);
  const [timeoutsLeft, setTimeoutsLeft] = useState(MAX_TIMEOUTS);
  const [mode, setMode] = useState("home");
  const [setTarget, setSetTarget] = useState(SET_TARGET); // セットの先取点数(15点制などに変更可)
  const [matchKind, setMatchKind] = useState("match"); // "match"=試合 / "scout"=観戦学習
  const [learnEntries, setLearnEntries] = useState(loadLearnEntries);
  const [learnApply, setLearnApply] = useState(true);
  const [selSlot, setSelSlot] = useState(null);
  const [editNames, setEditNames] = useState({ us: false, them: false });
  const [scoutRep, setScoutRep] = useState(null);
  const [scoutLoading, setScoutLoading] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  // ★AIフォームラボ
  const [formStatus, setFormStatus] = useState("idle"); // idle | loading | running
  const [formErr, setFormErr] = useState(null);
  const [mirror, setMirror] = useState(false);
  const [camFacing, setCamFacing] = useState("environment"); // スマホは外カメラをデフォルトに
  const [formSource, setFormSource] = useState(null); // "camera" | "file"
  const [formModel, setFormModel] = useState("full"); // lite | full | heavy
  const [trackQuality, setTrackQuality] = useState(null); // "good" | "partial"
  const modelRef = useRef(null); // 現在ロード済みのモデル名
  const [reps, setReps] = useState([]);
  const [liveM, setLiveM] = useState(null);
  const [formKind, setFormKind] = useState("スパイク");
  const [heightCm, setHeightCm] = useState("");
  const [formRefs, setFormRefs] = useState(loadFormRefs);
  const [formAdvice, setFormAdvice] = useState(null);
  const [formAdviceLoading, setFormAdviceLoading] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const landmarkerRef = useRef(null);
  const rafRef = useRef(0);
  const runningRef = useRef(false);
  const streamRef = useRef(null);
  const frameRef = useRef(null);
  const [setNo, setSetNo] = useState(1);
  const [setsWon, setSetsWon] = useState({ us: 0, them: 0 });
  const [archived, setArchived] = useState([]);
  const [setEnd, setSetEnd] = useState(null);
  const [menu, setMenu] = useState(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [story, setStory] = useState(null);
  const [storyLoading, setStoryLoading] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [flash, setFlash] = useState(null);
  const [particles, setParticles] = useState([]);
  const [shake, setShake] = useState(false);
  const judgedAt = useRef(-1);

  const labelOf = t => {
    const p = roster[t.team]?.[t.idx];
    if (!p) return "?";
    return `${t.team === "them" ? "相手" : ""}${p.pos}・${p.name}`;
  };

  // ★学習済みパラメータ(蓄積データから算出、トグルで適用ON/OFF)
  const learned = useMemo(() => computeLearnedParams(learnEntries), [learnEntries]);
  const lp = learnApply ? learned : null;
  const toF = lp?.toFactor ?? 0.45;

  const rallies = log.filter(r => r.type === "rally");
  const us = rallies.filter(r => r.e === 1).length;
  const them = rallies.filter(r => r.e === -1).length;
  const series = momentumSeries(log, toF);
  const m = series[series.length - 1];
  const pct = ((Math.max(M_MIN, Math.min(M_MAX, m)) - M_MIN) / (M_MAX - M_MIN)) * 100;
  const threat = assessThreat(log, us, them, labelOf, toF, setTarget);
  const threatPct = Math.min(100, (threat.score / 5) * 100);

  const rot = deriveRotation(log, firstServe);
  const courtIdx = (team, slot) => lineup[team][(rot[team] + slot - 1) % 6];
  const serverOf = team => roster[team][courtIdx(team, 1)];

  // ★リアルタイム勝率(モンテカルロ、サーブ権+学習パラメータ+先取点数反映)
  const wp = useMemo(() => winProbSim(us, them, m, rot.serving, lp, setTarget), [log.length, lp, setTarget]); // eslint-disable-line

  const isDeuce = us >= setTarget - 1 && them >= setTarget - 1;
  const setPointUs = !setEnd && us >= setTarget - 1 && us - them >= 1;
  const setPointThem = !setEnd && them >= setTarget - 1 && them - us >= 1;

  let streakDisp = 0;
  for (let i = rallies.length - 1; i >= 0; i--) {
    if (!streakDisp) streakDisp = rallies[i].e;
    else if (Math.sign(streakDisp) === rallies[i].e) streakDisp += rallies[i].e;
    else break;
  }

  // ===== セット終了判定 =====
  useEffect(() => {
    if (mode !== "game" || setEnd) return;
    const last = log[log.length - 1];
    if (!last || last.type !== "rally") return;
    const winner = setWinner(us, them, setTarget);
    if (winner) {
      setAlertS(null); setVerdict(null);
      setSetEnd({ winner });
      if (winner === "us") {
        const burst = Array.from({ length: 40 }, () => ({
          id: ++pid, x: 10 + Math.random() * 80,
          dx: (Math.random() - 0.5) * 320, dy: -(180 + Math.random() * 380),
          rot: (Math.random() - 0.5) * 720, size: 18 + Math.random() * 22,
          emoji: ["🏐", "🎉", "✨", "🏆", "🔥", "⭐"][Math.floor(Math.random() * 6)],
          dur: 1.2 + Math.random() * 1.0,
        }));
        setParticles(p => [...p, ...burst]);
        setTimeout(() => setParticles(p => p.filter(q => !burst.includes(q))), 2600);
      }
    }
  }, [log]); // eslint-disable-line

  // ===== 2段階AI判定 =====
  useEffect(() => {
    if (alert || timeout_ || judging || mode !== "game" || setEnd) return;
    if (matchKind === "scout") return; // 観戦学習モードはTO判定なし(記録に専念)
    const last = log[log.length - 1];
    if (!last || last.type !== "rally") return;
    if (setWinner(us, them, setTarget)) return;
    if (last.e === 1) { setVerdict(null); return; }
    if (threat.score < CANDIDATE_THRESHOLD) return;
    if (judgedAt.current === log.length) return;
    judgedAt.current = log.length;
    setJudging(true);
    const ctx = { us, them, timeoutsLeft, m, dM: threat.dM, streak: threat.streak, score: threat.score, factors: threat.factors, recent: rallies.slice(-8), labelOf, serving: rot.serving, wp, learnNote: lp?.note, target: setTarget };
    judgeWithLLM(ctx).then(v => {
      const result = v || localVerdict(threat);
      setJudging(false);
      const rec = { atIndex: log.length, alert: result.alert, urgency: result.urgency, reason: result.reason, us, them, m: +m.toFixed(2), action: result.alert ? "pending" : "hold" };
      setVerdicts(vs => [...vs, rec]);
      if (result.alert && timeoutsLeft > 0) {
        setAlertS({ ...result, recIndex: log.length });
        if (voiceOn) speak(`タイムアウト推奨。${result.reason}`);
      } else setVerdict(result);
    });
  }, [log]); // eslint-disable-line

  useEffect(() => {
    if (!timeout_ || timeout_.sec <= 0) return;
    const t = setTimeout(() => setTimeoutS(s => s && { ...s, sec: s.sec - 1 }), 1000);
    return () => clearTimeout(t);
  }, [timeout_]);

  const celebrate = (e) => {
    setFlash(e === 1 ? "win" : "lose");
    setTimeout(() => setFlash(null), 600);
    if (e === -1) { setShake(true); setTimeout(() => setShake(false), 450); }
    const emojis = e === 1 ? ["🏐", "✨", "🔥", "⭐", "💙"] : ["💧", "🌧", "💔"];
    const burst = Array.from({ length: e === 1 ? 16 : 8 }, () => ({
      id: ++pid, x: 50 + (Math.random() - 0.5) * 30,
      dx: (Math.random() - 0.5) * 220, dy: -(120 + Math.random() * 260),
      rot: (Math.random() - 0.5) * 540, size: 16 + Math.random() * 18,
      emoji: emojis[Math.floor(Math.random() * emojis.length)], dur: 0.9 + Math.random() * 0.7,
    }));
    setParticles(p => [...p, ...burst]);
    setTimeout(() => setParticles(p => p.filter(q => !burst.includes(q))), 1800);
  };

  // ラリー確定: ローテと勝率のスナップショットを記録(→ ローテ別分析・勝率曲線・ターニングポイント抽出)
  const commitRally = (pendingObj, target) => {
    const newUs = us + (pendingObj.e === 1 ? 1 : 0);
    const newThem = them + (pendingObj.e === -1 ? 1 : 0);
    const newM = ALPHA * m + pendingObj.w * pendingObj.e;
    const wpAfter = winProbSim(newUs, newThem, newM, pendingObj.e === 1 ? "us" : "them", lp, setTarget);
    setLog(l => [...l, {
      type: "rally", ...pendingObj, target, t: Date.now(),
      rotUs: rot.us % 6, rotThem: rot.them % 6, servingAtStart: rot.serving,
      wp: +wpAfter.toFixed(3), wpBefore: +wp.toFixed(3),
    }]);
    celebrate(pendingObj.e);
    setPending({}); setStep(0);
  };

  const tap1 = e => { setPending({ e }); setStep(1); };
  const tap2 = p => {
    // ★学習済みのW_t補正があれば自動適用(連続失点の引き金プレーを重く)
    const effW = (learnApply && learned?.weights?.[p.label]) || p.w;
    const next = { ...pending, play: p.label, w: effW };
    if (p.autoServer === "us") return commitRally(next, { team: "us", idx: courtIdx("us", 1) });
    if (p.autoServer === "them") return commitRally(next, { team: "them", idx: courtIdx("them", 1) });
    setPending(next); setStep(2);
  };
  const tap3 = (team, idx) => commitRally(pending, { team, idx });

  const undo = () => { judgedAt.current = -1; setVerdict(null); setLog(l => l.slice(0, -1)); };
  const takeTimeout = () => {
    setVerdicts(vs => vs.map(v => v.atIndex === alert?.recIndex ? { ...v, action: "taken" } : v));
    setLog(l => [...l, { type: "timeout", t: Date.now() }]);
    setTimeoutsLeft(n => n - 1);
    const advice = alert?.advice || "まず3本で確実に返すこと。";
    setTimeoutS({ advice, sec: 30 });
    if (voiceOn) speak(advice); // ★30秒間に音声で指示を読み上げ(画面を見せながら耳でも伝わる)
    setAlertS(null); setVerdict(null);
  };
  const dismiss = () => {
    setVerdicts(vs => vs.map(v => v.atIndex === alert?.recIndex ? { ...v, action: "ignored" } : v));
    setVerdict({ ...alert, alert: false, reason: "ベンチ判断で温存", dismissed: true });
    setAlertS(null);
  };

  const archiveCurrent = (winner) => {
    setArchived(a => [...a, { log, verdicts, us, them, winner, setNo }]);
    setSetsWon(s => ({ ...s, [winner]: s[winner] + 1 }));
  };
  const resetForNewSet = () => {
    setLog([]); setVerdicts([]); setTimeoutsLeft(MAX_TIMEOUTS);
    judgedAt.current = -1; setVerdict(null); setAlertS(null);
    setSetNo(n => n + 1); setSetEnd(null);
    setFirstServe(f => f === "us" ? "them" : "us");
  };
  const nextSet = () => { archiveCurrent(setEnd.winner); resetForNewSet(); setMode("setup"); };
  // ★試合終了時、自動でAI学習データに保存(試合モード=own / 観戦モード=pro)
  const finishMatch = () => {
    const finalSets = [...archived, { log, verdicts, us, them, winner: setEnd.winner, setNo }];
    const entry = {
      id: Date.now(), savedAt: new Date().toISOString(),
      source: matchKind === "scout" ? "pro" : "own",
      label: matchKind === "scout" ? "観戦学習記録" : "自チーム試合",
      sets: finalSets.map(s => ({ setNo: s.setNo, us: s.us, them: s.them, winner: s.winner, log: s.log })),
      roster, lineup,
    };
    setLearnEntries(es => { const n = [...es, entry]; saveLearnEntries(n); return n; });
    archiveCurrent(setEnd.winner); resetForNewSet(); setMode("report");
  };
  const undoFromSetEnd = () => { setSetEnd(null); undo(); };

  const goHome = () => {
    setLog([]); setVerdicts([]); setArchived([]); setSetsWon({ us: 0, them: 0 });
    setSetNo(1); setTimeoutsLeft(MAX_TIMEOUTS); setSetEnd(null);
    judgedAt.current = -1; setVerdict(null); setAlertS(null);
    setMenu(null); setStory(null); setSelSlot(null); setMode("home");
  };

  const deleteEntry = id => setLearnEntries(es => { const n = es.filter(e => e.id !== id); saveLearnEntries(n); return n; });

  // ★学習データのインポート(このアプリのエクスポートJSON or 学習バンドル)
  const handleImport = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        let added = [];
        if (data.type === "vbmc-learning" && Array.isArray(data.entries)) added = data.entries;
        else if (Array.isArray(data.sets)) {
          added = [{
            id: Date.now(), savedAt: data.exportedAt || new Date().toISOString(), source: "pro",
            label: file.name.replace(/\.json$/i, ""),
            sets: data.sets.map(s => ({
              setNo: s.setNo, winner: s.winner, log: s.log || [],
              us: +String(s.score).split("-")[0] || 0, them: +String(s.score).split("-")[1] || 0,
            })),
            roster: data.roster, lineup: data.lineup,
          }];
        }
        if (added.length) {
          setLearnEntries(es => { const n = [...es, ...added]; saveLearnEntries(n); return n; });
          setImportMsg(`✓ ${added.length}件の試合データを学習に追加しました`);
        } else setImportMsg("⚠ 対応していない形式です(このアプリのエクスポートJSONを指定してください)");
      } catch { setImportMsg("⚠ 読み込みに失敗しました"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const exportLearn = () => {
    const blob = new Blob([JSON.stringify({ type: "vbmc-learning", exportedAt: new Date().toISOString(), entries: learnEntries }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `volleyball_learning_${Date.now()}.json`;
    a.click();
  };

  // ★AI戦術レポート(学習データの統計→LLMで戦術知見化)
  const genScout = async () => {
    if (!learned) return;
    setScoutLoading(true);
    const lossTxt = Object.entries(learned.lossPlays).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}本`).join("、");
    const summary = `${learned.note} / 失点内訳: ${lossTxt}${learned.byServerN ? ` / サーブ順別得失点差: ${learned.byServer.map((s, i) => `${roster.us[i].name}${s.won - s.lost >= 0 ? "+" : ""}${s.won - s.lost}`).join("、")}` : ""}`;
    const r = await scoutReport(summary);
    setScoutRep(r || { title: "データ蓄積中", points: ["学習データをさらに蓄積すると、より具体的な戦術レポートを生成できます。観戦学習モードでプロや春高の試合を記録しましょう。"] });
    setScoutLoading(false);
  };

  // ===== ★AIフォームラボ: 骨格解析エンジン =====
  const stopForm = () => {
    runningRef.current = false;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) { v.onended = null; try { v.pause(); } catch { /* noop */ } }
    setFormStatus("idle"); setLiveM(null); setTrackQuality(null);
  };

  const ensureLandmarker = async () => {
    if (landmarkerRef.current && modelRef.current === formModel) return landmarkerRef.current;
    setFormStatus("loading");
    if (landmarkerRef.current) { try { landmarkerRef.current.close(); } catch { /* noop */ } landmarkerRef.current = null; }
    const vision = await import(/* webpackIgnore: true */ `${MP_URL}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    const opts = delegate => ({
      baseOptions: { modelAssetPath: POSE_MODELS[formModel], delegate },
      runningMode: "VIDEO", numPoses: 1,
      minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try {
      landmarkerRef.current = await vision.PoseLandmarker.createFromOptions(files, opts("GPU"));
    } catch {
      // GPU非対応端末はCPUにフォールバック
      landmarkerRef.current = await vision.PoseLandmarker.createFromOptions(files, opts("CPU"));
    }
    modelRef.current = formModel;
    return landmarkerRef.current;
  };

  const drawPose = lm => {
    const cv = canvasRef.current, v = videoRef.current;
    if (!cv || !v || !v.videoWidth) return;
    if (cv.width !== v.videoWidth) { cv.width = v.videoWidth; cv.height = v.videoHeight; }
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!lm) return;
    ctx.strokeStyle = "#46d68c"; ctx.lineWidth = Math.max(2, cv.width / 220);
    POSE_LINKS.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(lm[a].x * cv.width, lm[a].y * cv.height);
      ctx.lineTo(lm[b].x * cv.width, lm[b].y * cv.height);
      ctx.stroke();
    });
    ctx.fillStyle = "#FFC83D";
    [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].forEach(i => {
      ctx.beginPath(); ctx.arc(lm[i].x * cv.width, lm[i].y * cv.height, Math.max(3, cv.width / 160), 0, Math.PI * 2); ctx.fill();
    });
  };

  // 1フレームごとの計測+スイング自動検出(状態機械)。返り値は描画用の平滑化済み骨格
  const processFrame = (lm, tMs) => {
    const fs = frameRef.current;
    // ★EMA平滑化: ジッタ(骨格のブレ)による誤計測・誤検出を抑える
    if (!fs.smooth) fs.smooth = lm.map(p => ({ x: p.x, y: p.y }));
    else lm.forEach((p, i) => { const s = fs.smooth[i]; s.x += (p.x - s.x) * SMOOTH_ALPHA; s.y += (p.y - s.y) * SMOOTH_ALPHA; });
    const pts = fs.smooth;

    // ★可視性ゲート: 鼻・手首・膝・足首が映っていないフレームは計測しない(描画のみ)
    const minVis = Math.min(...KEY_VIS_POINTS.map(i => lm[i].visibility ?? 1));
    const quality = minVis > 0.5 ? "good" : "partial";
    if (fs.lastQ !== quality) { fs.lastQ = quality; setTrackQuality(quality); }
    if (quality === "partial") { fs.prevWrist = null; return pts; }

    const noseY = pts[0].y;
    const ankleY = (pts[27].y + pts[28].y) / 2;
    const bodyH = Math.max(0.1, ankleY - noseY); // 鼻〜足首の正規化身長
    const hipY = (pts[23].y + pts[24].y) / 2;
    const knee = Math.min(angleDeg(pts[23], pts[25], pts[27]), angleDeg(pts[24], pts[26], pts[28]));
    const rightUp = pts[16].y < pts[15].y;
    const wrist = rightUp ? pts[16] : pts[15];
    const elbow = rightUp ? angleDeg(pts[12], pts[14], pts[16]) : angleDeg(pts[11], pts[13], pts[15]);
    const wristH = (noseY - wrist.y) / bodyH; // 手首が鼻よりどれだけ上か(身長比)
    let speed = 0;
    if (fs.prevWrist && tMs > fs.prevT) speed = Math.hypot(wrist.x - fs.prevWrist.x, wrist.y - fs.prevWrist.y) / bodyH / ((tMs - fs.prevT) / 1000);
    fs.prevWrist = { x: wrist.x, y: wrist.y }; fs.prevT = tMs;
    // 直近2秒の最小膝角度(助走の沈み込み)
    fs.kneeWin.push({ t: tMs, knee });
    while (fs.kneeWin.length && tMs - fs.kneeWin[0].t > 2000) fs.kneeWin.shift();
    // 腰の基準線(非スイング時のみ更新)→ ジャンプ量
    if (fs.hipBase === null) fs.hipBase = hipY;
    if (fs.state === "idle") fs.hipBase = fs.hipBase * 0.95 + hipY * 0.05;
    const jump = Math.max(0, (fs.hipBase - hipY) / bodyH);

    if (fs.state === "idle" && wristH > 0.05 && tMs - fs.lastRepAt > 800) {
      fs.state = "swing";
      fs.rep = { startT: tMs, maxWristH: wristH, elbowAtMax: elbow, maxSpeed: speed, maxJump: jump, minKnee: Math.min(...fs.kneeWin.map(k => k.knee)) };
    } else if (fs.state === "swing") {
      const r = fs.rep;
      if (wristH > r.maxWristH) { r.maxWristH = wristH; r.elbowAtMax = elbow; }
      r.maxSpeed = Math.max(r.maxSpeed, speed);
      r.maxJump = Math.max(r.maxJump, jump);
      if (wristH < -0.02) { // 手首が鼻の下に戻った=スイング終了
        fs.state = "idle"; fs.lastRepAt = tMs;
        // ★誤検出フィルタ: 高さ(打点に届いた)+速度(振った)+持続時間(瞬間ノイズでない)を満たすものだけ採用
        // → 「ただ手を挙げただけ」「一瞬の検出ブレ」はカウントしない
        if (r.maxWristH > 0.10 && r.maxSpeed >= 2.0 && tMs - r.startT >= 120) {
          setReps(rs => [...rs, { ...r, score: repScore(r), t: Date.now() }].slice(-30));
        }
        fs.rep = null;
      }
    }
    if (++fs.frame % 5 === 0) setLiveM({ knee: Math.round(knee), elbow: Math.round(elbow), wristH, jump });
    return pts;
  };

  const startForm = async (source, file, facing = camFacing) => {
    try {
      setFormErr(null);
      await ensureLandmarker();
      // 既存ループ・ストリームを止めてから開始(カメラ切替時の二重ループ防止)
      runningRef.current = false;
      cancelAnimationFrame(rafRef.current);
      const v = videoRef.current;
      streamRef.current?.getTracks().forEach(t => t.stop());
      if (source === "camera") {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        v.srcObject = stream; streamRef.current = stream;
        setMirror(facing === "user"); // 内カメラのみ鏡映しにする
      } else {
        v.srcObject = null; v.src = URL.createObjectURL(file); setMirror(false);
      }
      setFormSource(source);
      v.onended = source === "file" ? () => stopForm() : null; // 動画終了で自動停止
      await v.play();
      frameRef.current = { state: "idle", lastRepAt: 0, hipBase: null, kneeWin: [], prevWrist: null, prevT: 0, rep: null, frame: 0, smooth: null, lastQ: null };
      runningRef.current = true;
      setTrackQuality(null);
      setFormStatus("running");
      // ★動画ファイルは各フレームを正確に1回ずつ処理(コマ落ち・重複防止)。カメラは描画レートに同期
      const useRVFC = source === "file" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
      const step = () => {
        if (!runningRef.current) return;
        const vid = videoRef.current;
        if (vid && vid.readyState >= 2 && !vid.paused && !vid.ended) {
          try {
            const now = performance.now();
            const res = landmarkerRef.current.detectForVideo(vid, now);
            const lm = res.landmarks?.[0];
            drawPose(lm ? processFrame(lm, now) : null);
          } catch { /* フレーム失敗は無視 */ }
        }
        if (useRVFC) vid.requestVideoFrameCallback(() => step());
        else rafRef.current = requestAnimationFrame(step);
      };
      step();
    } catch (e) {
      stopForm();
      setFormErr(source === "camera"
        ? "カメラを起動できませんでした。ブラウザのカメラ許可と、他アプリがカメラを使っていないかを確認してください。"
        : "解析エンジンまたは動画の読み込みに失敗しました。通信環境を確認してください。");
    }
  };

  // フォームラボを離れたら必ずカメラ・解析を停止
  useEffect(() => { if (mode !== "form") stopForm(); }, [mode]); // eslint-disable-line

  const repAvg = reps.length ? {
    score: reps.reduce((s, r) => s + r.score, 0) / reps.length,
    hit: reps.reduce((s, r) => s + r.maxWristH, 0) / reps.length,
    elbow: reps.reduce((s, r) => s + r.elbowAtMax, 0) / reps.length,
    knee: reps.reduce((s, r) => s + r.minKnee, 0) / reps.length,
    jump: reps.reduce((s, r) => s + r.maxJump, 0) / reps.length,
    n: reps.length,
  } : null;

  // ★お手本リスト操作(同じ種目内でONは1つだけ=比較対象)
  const persistRefs = refs => { try { localStorage.setItem(FORM_REFS_KEY, JSON.stringify(refs)); } catch { /* noop */ } return refs; };
  const addFormRef = () => {
    if (!repAvg) return;
    const entry = {
      id: `ref-${Date.now()}`, label: `マイお手本 ${new Date().toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}`,
      kind: formKind, hit: repAvg.hit, elbow: repAvg.elbow, knee: repAvg.knee, jump: repAvg.jump,
      n: repAvg.n, enabled: true, savedAt: new Date().toISOString(),
    };
    setFormRefs(rs => persistRefs([...rs.map(r => r.kind === formKind ? { ...r, enabled: false } : r), entry]));
  };
  const toggleFormRef = id => setFormRefs(rs => {
    const target = rs.find(r => r.id === id);
    if (!target) return rs;
    const turningOn = !target.enabled;
    return persistRefs(rs.map(r =>
      r.id === id ? { ...r, enabled: turningOn }
        : turningOn && r.kind === target.kind ? { ...r, enabled: false }
          : r
    ));
  });
  const deleteFormRef = id => setFormRefs(rs => persistRefs(rs.filter(r => r.id !== id)));
  const restorePresets = () => setFormRefs(rs =>
    persistRefs([...rs, ...BUILTIN_REFS.filter(b => !rs.some(r => r.id === b.id)).map(b => ({ ...b, enabled: false }))])
  );
  const presetsMissing = BUILTIN_REFS.some(b => !formRefs.some(r => r.id === b.id));
  const activeRef = formRefs.find(r => r.enabled && r.kind === formKind);

  const jumpCmOf = j => heightCm ? ` (約${Math.round(j * +heightCm * 0.85)}cm)` : "";

  const genFormAdvice = async () => {
    if (!repAvg) return;
    setFormAdviceLoading(true);
    const fmt = a => `打点+${Math.round(a.hit * 100)}% / 肘${Math.round(a.elbow)}° / 膝${Math.round(a.knee)}° / ジャンプ${Math.round(a.jump * 100)}%`;
    const summary = `種目: ${formKind} / 本数: ${repAvg.n} / 平均スコア${Math.round(repAvg.score)}点 / 計測平均: ${fmt(repAvg)}${activeRef ? ` / お手本(${activeRef.label}): ${fmt(activeRef)}` : ""}`;
    const pts = await formCoachLLM(summary);
    setFormAdvice(pts || FALLBACK_FORM_TIPS);
    setFormAdviceLoading(false);
  };

  const editName = (team, idx, name) => {
    setRoster(r => ({ ...r, [team]: r[team].map((p, i) => i === idx ? { ...p, name } : p) }));
  };
  // 対角チェック: P1-P4 / P2-P5 / P3-P6 が対角ペア(同ポジション、またはセッター⇔ライト)か
  const pairOk = (a, b) => a === b || (a === "セッター" && b === "ライト") || (a === "ライト" && b === "セッター");
  const diagonalOk = team => [0, 1, 2].every(i =>
    pairOk(roster[team][lineup[team][i]].pos, roster[team][lineup[team][i + 3]].pos)
  );

  // ===== レポート集計 =====
  const allSets = [...archived, ...(rallies.length ? [{ log, verdicts, us, them, winner: null, setNo }] : [])];
  const combinedLogs = allSets.map(s => s.log);
  const combinedRallies = combinedLogs.flat().filter(r => r.type === "rally");
  const calib = calibrateWeights(combinedLogs);
  const afterTO = allSets.flatMap(s =>
    s.log.map((r, i) => r.type === "timeout" ? i : -1).filter(i => i >= 0).map(i => next3Outcome(s.log, i + 1))
  ).filter(Boolean);
  const ignoredOut = allSets.flatMap(s =>
    s.verdicts.filter(v => v.action === "ignored").map(v => next3Outcome(s.log, v.atIndex))
  ).filter(Boolean);
  const rateOf = arr => arr.length ? arr.reduce((s, o) => s + o.won, 0) / arr.reduce((s, o) => s + o.n, 0) : null;
  const toRate = rateOf(afterTO), igRate = rateOf(ignoredOut);
  const verdictsAll = allSets.flatMap(s => s.verdicts.map(v => ({ ...v, _log: s.log })));
  const alertVerdicts = verdictsAll.filter(v => v.alert);
  const correctAlerts = alertVerdicts.filter(v => {
    const o = next3Outcome(v._log, v.atIndex);
    return o && o.won <= 1;
  }).length;

  const lossByPlayer = {}; const winByPlayer = {};
  const lossByOppPos = { "レフト": 0, "センター": 0, "ライト": 0, "セッター": 0 };
  let aceByOpp = 0, ownErrCount = 0;
  const rotStats = Array.from({ length: 6 }, () => ({ won: 0, lost: 0 }));
  combinedRallies.forEach(r => {
    const key = tKey(r.target);
    if (r.e === -1) {
      lossByPlayer[key] = (lossByPlayer[key] || 0) + 1;
      if (r.play === "被サーブ") aceByOpp++;
      else if (r.play === "自滅エラー") ownErrCount++;
      else if (r.target.team === "them") {
        const pos = roster.them[r.target.idx]?.pos;
        if (pos in lossByOppPos) lossByOppPos[pos]++;
      }
    } else if (r.target.team === "us") {
      winByPlayer[key] = (winByPlayer[key] || 0) + 1;
    }
    if (typeof r.rotUs === "number") rotStats[r.rotUs][r.e === 1 ? "won" : "lost"]++;
  });
  const keyToTarget = k => { const [team, idx] = k.split("-"); return { team, idx: +idx }; };
  const topLoss = Object.entries(lossByPlayer).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const topWin = Object.entries(winByPlayer).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const lossByPlay = {};
  combinedRallies.filter(r => r.e === -1).forEach(r => { lossByPlay[r.play] = (lossByPlay[r.play] || 0) + 1; });
  const topLossPlay = Object.entries(lossByPlay).sort((a, b) => b[1] - a[1]);
  const worstRot = rotStats.map((s, i) => ({ i, ...s, diff: s.won - s.lost })).filter(s => s.won + s.lost >= 3).sort((a, b) => a.diff - b.diff)[0];

  // ★試合中の「鬼門ローテ」事前警告(今日のデータからこのローテが弱いと検知したら入った瞬間に知らせる)
  const curRot = rot.us % 6;
  const curRotStat = rotStats[curRot];
  const weakRotNow = mode === "game" && curRotStat.won + curRotStat.lost >= 3 && curRotStat.lost - curRotStat.won >= 2;

  // ★ターニングポイント抽出(勝率の変動が大きかったラリー Top3)
  const turningPoints = allSets.flatMap((s, si) =>
    s.log.filter(r => r.type === "rally" && typeof r.wp === "number" && typeof r.wpBefore === "number")
      .map((r, _, arr) => ({ r, si, d: Math.abs(r.wp - r.wpBefore), idxInSet: s.log.indexOf(r) }))
  ).sort((a, b) => b.d - a.d).slice(0, 3);

  const genMenu = async () => {
    setMenuLoading(true);
    const stats = `失点内訳: ${topLossPlay.map(([k, v]) => `${k}${v}本`).join("、")} / 失点元(選手別): ${topLoss.map(([k, v]) => `${labelOf(keyToTarget(k))}${v}本`).join("、")}${worstRot ? ` / 弱いローテ: R${worstRot.i + 1}(${worstRot.won}得点${worstRot.lost}失点)` : ""} / セットカウント ${setsWon.us}-${setsWon.them}`;
    const result = await practiceMenu(stats);
    setMenu(result || FALLBACK_MENU);
    setMenuLoading(false);
  };

  const genStory = async () => {
    setStoryLoading(true);
    const tp = turningPoints.map(t => {
      const before = Math.round(t.r.wpBefore * 100), after = Math.round(t.r.wp * 100);
      return `SET${allSets[t.si].setNo || t.si + 1}で${labelOf(t.r.target)}の${t.r.play}(勝率${before}%→${after}%)`;
    }).join("、");
    const summary = `セットカウント自${setsWon.us}-${setsWon.them}相手 / セットスコア: ${allSets.map(s => `${s.us}-${s.them}`).join(", ")} / 得点源: ${topWin.map(([k, v]) => `${labelOf(keyToTarget(k))}${v}点`).join("、")} / ターニングポイント: ${tp || "なし"} / タイムアウト${afterTO.length}回実施`;
    const result = await matchStory(summary);
    setStory(result || { headline: "熱戦の記録", story: `セットカウント${setsWon.us}-${setsWon.them}。${topWin.length ? labelOf(keyToTarget(topWin[0][0])) + "がチームを牽引した。" : ""}データは次の勝利への足がかりだ。` });
    setStoryLoading(false);
  };

  // ★研究用データエクスポート(JSON)
  const exportData = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      model: { alpha: ALPHA, weights: PLAYS, candidateThreshold: CANDIDATE_THRESHOLD },
      roster, lineup, setsWon,
      sets: allSets.map(s => ({ setNo: s.setNo, score: `${s.us}-${s.them}`, winner: s.winner, log: s.log, aiVerdicts: s.verdicts })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `volleyball_match_${Date.now()}.json`;
    a.click();
  };

  const heat = Math.max(-1, Math.min(1, m / M_MAX));
  const C = { us: "#3D8BFF", them: "#FF4A3D", warn: "#FFC83D", txt: "#EAF0FF", dim: "#8A96B8", line: "#2A3450", ok: "#46d68c" };
  const auraColor = heat < 0 ? `rgba(255,74,61,${Math.min(.4, -heat * .45)})` : `rgba(61,139,255,${Math.min(.4, heat * .45)})`;
  const threatColor = threatPct < 45 ? C.ok : threatPct < 70 ? C.warn : C.them;
  const threatLabel = threatPct < 45 ? "平常" : threatPct < 70 ? "注視" : "危険";
  const panel = { background: "linear-gradient(180deg, #161E33, #11182B)", borderRadius: 22, padding: 16, border: `1px solid ${C.line}` };
  const btn = (bg, extra = {}) => ({
    background: bg, color: "#fff", border: "none", borderRadius: 18,
    fontFamily: "'Noto Sans JP', sans-serif", fontWeight: 800, cursor: "pointer",
    padding: "20px 8px", fontSize: 18, width: "100%", transition: "transform .08s", ...extra,
  });
  const press = e => { e.currentTarget.style.transform = "scale(.93)"; };
  const release = e => { e.currentTarget.style.transform = "scale(1)"; };
  const ringR = 84, ringC = 2 * Math.PI * ringR;
  const posColor = pos => pos === "レフト" ? "#FF8C42" : pos === "ライト" ? "#B66EFF" : pos === "セッター" ? "#46d68c" : "#4DD0E1";

  // セット別チャート(モメンタム+勝率の2本立て)
  const chartW = 320, chartH = 110, padX = 12;
  const SetChart = ({ s, label }) => {
    const ser = momentumSeries(s.log, toF);
    const n = ser.length;
    const px = i => padX + (n > 1 ? (i / (n - 1)) * (chartW - padX * 2) : 0);
    const py = v => chartH / 2 - (Math.max(M_MIN, Math.min(M_MAX, v)) / M_MAX) * (chartH / 2 - 12);
    const pyW = w => chartH - 12 - w * (chartH - 24); // 勝率0-1
    const d = ser.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    // 勝率曲線(記録済みのwpスナップショットから)
    const wpPts = [{ x: px(0), y: pyW(0.5) }];
    s.log.forEach((r, i) => { if (r.type === "rally" && typeof r.wp === "number") wpPts.push({ x: px(i + 1), y: pyW(r.wp) }); });
    const dW = wpPts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const tos = s.log.map((r, i) => r.type === "timeout" ? i : -1).filter(i => i >= 0);
    return (
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 2, color: s.winner === "us" ? C.us : s.winner === "them" ? C.them : C.dim }}>
          {label} {s.us}-{s.them} {s.winner === "us" ? "○獲得" : s.winner === "them" ? "●失う" : "(進行中)"}
        </div>
        <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ width: "100%" }}>
          <line x1={padX} y1={chartH / 2} x2={chartW - padX} y2={chartH / 2} stroke={C.line} strokeDasharray="3 3" />
          <path d={dW} fill="none" stroke={C.warn} strokeWidth="1.5" opacity=".8" strokeDasharray="4 3" />
          <path d={d} fill="none" stroke={C.us} strokeWidth="2.5" strokeLinejoin="round" />
          {tos.map((idx, i) => (
            <g key={i}>
              <circle cx={px(idx + 1)} cy={py(ser[idx + 1])} r="6" fill={C.warn} />
              <text x={px(idx + 1)} y={py(ser[idx + 1]) + 3} textAnchor="middle" fontSize="7" fontWeight="bold" fill="#1a1a1a">T</text>
            </g>
          ))}
          {s.verdicts.filter(v => v.action === "ignored").map((v, i) => (
            <circle key={i} cx={px(v.atIndex)} cy={py(ser[v.atIndex] ?? 0)} r="5" fill="none" stroke={C.them} strokeWidth="2" />
          ))}
        </svg>
      </div>
    );
  };

  // ★コート・ヒートマップ: 相手のどこから失点しているか
  const CourtHeatmap = () => {
    const max = Math.max(1, ...Object.values(lossByOppPos), aceByOpp, ownErrCount);
    const zone = (cx, cy, count, lbl, color) => {
      const r = 10 + (count / max) * 22;
      return (
        <g>
          <circle cx={cx} cy={cy} r={r} fill={color} opacity={count ? 0.25 + (count / max) * 0.55 : 0.08} />
          <text x={cx} y={cy - 2} textAnchor="middle" fontSize="10" fontWeight="900" fill="#fff">{count}</text>
          <text x={cx} y={cy + 10} textAnchor="middle" fontSize="7" fill="#cfd8ec">{lbl}</text>
        </g>
      );
    };
    // 相手コートは対面: 相手のレフトはこちらから見て右側
    return (
      <svg viewBox="0 0 320 190" style={{ width: "100%" }}>
        <rect x="20" y="10" width="280" height="80" rx="4" fill="#1c2742" stroke={C.line} />
        <rect x="20" y="100" width="280" height="80" rx="4" fill="#141d33" stroke={C.line} />
        <line x1="20" y1="95" x2="300" y2="95" stroke="#fff" strokeWidth="3" opacity=".7" />
        <text x="160" y="98" textAnchor="middle" fontSize="8" fill="#fff" opacity=".9">━ ネット ━</text>
        <text x="28" y="22" fontSize="8" fill={C.them} fontWeight="900">相手コート(攻撃の出どころ)</text>
        <text x="28" y="172" fontSize="8" fill={C.us} fontWeight="900">自コート</text>
        {zone(250, 55, lossByOppPos["レフト"], "相手レフト", C.them)}
        {zone(160, 55, lossByOppPos["センター"], "相手センター", C.them)}
        {zone(70, 55, lossByOppPos["ライト"] + lossByOppPos["セッター"], "相手ライト", C.them)}
        {zone(160, 24, aceByOpp, "サーブ", "#B66EFF")}
        {zone(160, 140, ownErrCount, "自滅エラー", C.warn)}
      </svg>
    );
  };

  const CourtSelect = ({ team, onPick }) => {
    const slots = [[4, 3, 2], [5, 6, 1]];
    const serving = rot.serving === team;
    return (
      <div>
        <div style={{ textAlign: "center", fontSize: 10, color: C.dim, fontWeight: 800, letterSpacing: 4, marginBottom: 6 }}>━━ ネット ━━</div>
        {slots.map((row, ri) => (
          <div key={ri} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            {row.map(slot => {
              const idx = courtIdx(team, slot);
              const p = roster[team][idx];
              const isServer = slot === 1 && serving;
              return (
                <button key={slot}
                  style={btn(team === "us" ? "linear-gradient(160deg, #2a3f6e, #1e2d50)" : "linear-gradient(160deg, #5e2a33, #45202a)", {
                    padding: "12px 4px", fontSize: 14,
                    border: isServer ? `2px solid ${C.warn}` : "2px solid transparent",
                  })}
                  onPointerDown={press} onPointerUp={release} onPointerLeave={release}
                  onClick={() => onPick(team, idx)}>
                  <span style={{ fontSize: 9, fontWeight: 900, color: C.dim }}>P{slot}{isServer ? " 🏐" : ""}</span><br />
                  <span style={{ fontSize: 9, fontWeight: 900, color: posColor(p.pos) }}>{p.pos}</span><br />
                  <span style={{ fontSize: 14 }}>{p.name}</span>
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ textAlign: "center", fontSize: 9, color: C.dim }}>上段=前衛 / 下段=後衛(P1=サーバー)</div>
      </div>
    );
  };

  // ★コート型ローテーション設定(カード2枚タップで入れ替え)
  // ※コンポーネントではなく関数呼び出しでレンダリングする(毎レンダー再マウントによる入力フォーカス切れ防止)
  const renderCourtSetup = (team) => {
    const isUs = team === "us";
    const rows = [[4, 3, 2], [5, 6, 1]];
    const swap = (i, j) => setLineup(l => {
      const a = [...l[team]]; [a[i], a[j]] = [a[j], a[i]];
      return { ...l, [team]: a };
    });
    return (
      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 900, color: isUs ? C.us : C.them }}>
            {isUs ? "🔵 自チームの配置" : "🔴 相手チームの配置"}
          </span>
          <span style={{ fontSize: 10, fontWeight: 900, padding: "3px 10px", borderRadius: 8, background: diagonalOk(team) ? "rgba(70,214,140,.15)" : "rgba(255,200,61,.15)", color: diagonalOk(team) ? C.ok : C.warn }}>
            {diagonalOk(team) ? "✓ 対角OK" : "⚠ 対角が崩れています"}
          </span>
        </div>
        <div style={{ textAlign: "center", fontSize: 10, color: C.dim, fontWeight: 800, letterSpacing: 3, marginBottom: 8 }}>━━ ネット側(前衛) ━━</div>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            {row.map(slot => {
              const i = slot - 1, idx = lineup[team][i], p = roster[team][idx];
              const isServer = slot === 1 && firstServe === team;
              const isSel = selSlot && selSlot.team === team && selSlot.i === i;
              return (
                <button key={slot}
                  onClick={() => {
                    if (!selSlot || selSlot.team !== team) setSelSlot({ team, i });
                    else if (selSlot.i === i) setSelSlot(null);
                    else { swap(selSlot.i, i); setSelSlot(null); }
                  }}
                  style={btn(isUs ? "linear-gradient(160deg, #2a3f6e, #1e2d50)" : "linear-gradient(160deg, #5e2a33, #45202a)", {
                    padding: "16px 4px", position: "relative",
                    border: isSel ? `2px dashed ${C.warn}` : isServer ? `2px solid ${C.warn}` : "2px solid transparent",
                    boxShadow: isSel ? `0 0 16px ${C.warn}55` : "none",
                  })}>
                  {isServer && <span style={{ position: "absolute", top: 6, right: 8, fontSize: 14 }}>🏐</span>}
                  <span style={{ fontSize: 10, fontWeight: 900, color: C.dim, letterSpacing: 1 }}>P{slot}</span><br />
                  <span style={{ fontSize: 11, fontWeight: 900, color: posColor(p.pos) }}>{p.pos}</span><br />
                  <span style={{ fontSize: 16, fontWeight: 900 }}>{p.name}</span>
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 10, color: C.dim }}>
            {selSlot?.team === team ? "👆 入れ替え先のカードをタップ" : "カードを2枚タップで選手を入れ替え"}
          </span>
          <button onClick={() => setEditNames(s => ({ ...s, [team]: !s[team] }))}
            style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontWeight: 800, fontSize: 11 }}>
            {editNames[team] ? "✕ 閉じる" : "✏ 名前を編集"}
          </button>
        </div>
        {editNames[team] && (
          <div style={{ marginTop: 10 }}>
            {lineup[team].map((rosterIdx, i) => {
              const p = roster[team][rosterIdx];
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ fontFamily: "Oswald", fontWeight: 700, fontSize: 13, width: 26, color: i === 0 ? C.warn : C.dim }}>P{i + 1}</span>
                  <span style={{ fontSize: 10, fontWeight: 900, padding: "5px 0", borderRadius: 8, width: 56, textAlign: "center", background: `${posColor(p.pos)}22`, color: posColor(p.pos), border: `1px solid ${posColor(p.pos)}55` }}>{p.pos}</span>
                  <input value={p.name} onChange={e => editName(team, rosterIdx, e.target.value)} maxLength={10} placeholder="名前"
                    style={{ flex: 1, minWidth: 0, background: "#0A0F1E", border: `1px solid ${C.line}`, borderRadius: 10, color: C.txt, padding: "9px 10px", fontSize: 13, fontWeight: 700, fontFamily: "'Noto Sans JP', sans-serif", outline: "none" }} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ★ホーム画面の機能カード
  const HomeCard = ({ emoji, title, desc, accent, badge, onClick }) => (
    <button onClick={onClick} onPointerDown={press} onPointerUp={release} onPointerLeave={release}
      style={{
        ...panel, display: "flex", alignItems: "center", gap: 14, cursor: "pointer", textAlign: "left",
        width: "100%", color: C.txt, fontFamily: "'Noto Sans JP', sans-serif", transition: "transform .08s",
        border: `1px solid ${accent}44`, boxShadow: `0 4px 18px ${accent}22`,
      }}>
      <span style={{ fontSize: 30 }}>{emoji}</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 900 }}>{title}</span>
          {badge && <span style={{ fontSize: 9, fontWeight: 900, padding: "2px 8px", borderRadius: 8, background: `${accent}22`, color: accent }}>{badge}</span>}
        </span>
        <span style={{ display: "block", fontSize: 11, color: C.dim, lineHeight: 1.7, marginTop: 4 }}>{desc}</span>
      </span>
      <span style={{ fontSize: 20, color: accent }}>›</span>
    </button>
  );

  return (
    <div style={{
      minHeight: "100vh", color: C.txt, fontFamily: "'Noto Sans JP', sans-serif",
      display: "flex", justifyContent: "center", position: "relative", overflow: "hidden",
      background: `radial-gradient(120% 90% at 50% -10%, ${auraColor}, transparent 60%), #0A0F1E`,
      transition: "background 1s", animation: shake ? "shake .45s" : "none",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@600;700&family=Noto+Sans+JP:wght@500;700;900&display=swap');
        @keyframes pop { 0%{transform:scale(1)} 35%{transform:scale(1.45) rotate(-4deg)} 100%{transform:scale(1)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
        @keyframes shake { 0%,100%{transform:translateX(0)} 20%{transform:translateX(-8px)} 40%{transform:translateX(7px)} 60%{transform:translateX(-5px)} 80%{transform:translateX(3px)} }
        @keyframes flashIn { 0%{opacity:.85} 100%{opacity:0} }
        @keyframes rise { 0%{transform:translate(0,0) rotate(0); opacity:1} 100%{transform:translate(var(--dx), var(--dy)) rotate(var(--rot)); opacity:0} }
        @keyframes slideUp { 0%{transform:translateY(18px); opacity:0} 100%{transform:translateY(0); opacity:1} }
        @keyframes siren { 0%,100%{box-shadow:0 0 0 0 rgba(255,74,61,.8)} 50%{box-shadow:0 0 60px 14px rgba(255,74,61,.55)} }
        @keyframes floatBall { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-3px)} }
        @keyframes marquee { 0%{background-position:0 0} 100%{background-position:56px 0} }
        @keyframes comboPop { 0%{transform:scale(.4) rotate(-8deg); opacity:0} 60%{transform:scale(1.2) rotate(3deg)} 100%{transform:scale(1)} }
        @keyframes zoomIn { 0%{transform:scale(.6); opacity:0} 100%{transform:scale(1); opacity:1} }
        input::placeholder { color: #5a6685; }
      `}</style>

      {flash && (
        <div style={{ position: "fixed", inset: 0, zIndex: 40, pointerEvents: "none", background: flash === "win" ? "radial-gradient(circle, rgba(61,139,255,0) 30%, rgba(61,139,255,.9))" : "radial-gradient(circle, rgba(255,74,61,0) 30%, rgba(255,74,61,.9))", animation: "flashIn .6s ease-out forwards" }} />
      )}
      <div style={{ position: "fixed", inset: 0, zIndex: 65, pointerEvents: "none" }}>
        {particles.map(p => (
          <span key={p.id} style={{ position: "absolute", left: `${p.x}%`, top: "45%", fontSize: p.size, "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, "--rot": `${p.rot}deg`, animation: `rise ${p.dur}s ease-out forwards` }}>{p.emoji}</span>
        ))}
      </div>

      <div style={{ width: "100%", maxWidth: 430, padding: "16px 16px 24px", display: "flex", flexDirection: "column", gap: 14, position: "relative", zIndex: 10 }}>

        {mode === "home" ? (<>
          {/* ============ ホーム画面 ============ */}
          <div style={{ textAlign: "center", marginTop: 20 }}>
            <div style={{ fontSize: 48, animation: "floatBall 2.4s ease-in-out infinite" }}>🏐</div>
            <div style={{ fontFamily: "Oswald", fontSize: 27, fontWeight: 700, letterSpacing: 3 }}>MOMENTUM COACH AI</div>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 700, marginTop: 6 }}>流れを読むAIが、ベンチワークを変える</div>
          </div>

          {learned && (
            <div style={{ textAlign: "center", fontSize: 11, fontWeight: 800, color: learnApply ? C.ok : C.dim }}>
              🧠 学習済み: {learned.matches}試合 / {learned.ralliesN}ラリー{learnApply ? "(AIに適用中)" : "(適用OFF)"}
            </div>
          )}

          <HomeCard emoji="🏐" title="試合モード" accent={C.us}
            desc="自チームの試合をリアルタイム記録。AIがタイムアウトの取り時を2段階判定し、勝率と流れを可視化する。"
            onClick={() => { setMatchKind("match"); setSelSlot(null); setMode("setup"); }} />
          <HomeCard emoji="📺" title="観戦・学習モード" accent="#B66EFF"
            desc="プロや春高の試合を動画・観戦しながら記録。データは自動でAIの学習素材になり、判定精度が上がる。"
            onClick={() => { setMatchKind("scout"); setSelSlot(null); setMode("setup"); }} />
          <HomeCard emoji="🎥" title="AIフォームラボ" accent={C.warn}
            badge="リアルタイム映像AI"
            desc="カメラ・動画から骨格を端末内でリアルタイム解析。スパイク/サーブを自動検出して採点し、プロのお手本と比較。"
            onClick={() => setMode("form")} />
          <HomeCard emoji="🧠" title="AI学習センター" accent={C.ok}
            badge={learnEntries.length ? `${learnEntries.length}試合` : null}
            desc="蓄積データからサイドアウト率・プレー重み・TO効果・サーブ順の強さを学習。AI戦術レポートも生成。"
            onClick={() => setMode("learn")} />

          <div style={{ fontSize: 10, color: C.dim, textAlign: "center", lineHeight: 1.8 }}>
            卒業研究プロトタイプ — モメンタム理論に基づくタイムアウト判定支援
          </div>
        </>) : mode === "learn" ? (<>
          {/* ============ AI学習センター ============ */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>🧠 AI学習センター</div>
            <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "6px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }} onClick={() => setMode("home")}>← ホーム</button>
          </div>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.7 }}>
            観戦・学習モードで記録した試合や、インポートしたプロ・春高の試合データからAIが統計学習します。学習結果はTO判定・勝率予測・モメンタム計算に自動で反映されます。
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>📚 学習データ</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, textAlign: "center" }}>
              {[
                ["自チーム試合", learnEntries.filter(e => e.source === "own").length, C.us],
                ["観戦・外部", learnEntries.filter(e => e.source === "pro").length, "#B66EFF"],
                ["総ラリー", learned?.ralliesN ?? 0, C.warn],
              ].map(([lbl, v, col]) => (
                <div key={lbl} style={{ background: "#0A0F1E", borderRadius: 12, padding: 10 }}>
                  <div style={{ fontFamily: "Oswald", fontSize: 24, color: col }}>{v}</div>
                  <div style={{ fontSize: 9, color: C.dim }}>{lbl}</div>
                </div>
              ))}
            </div>
            <button onClick={() => setLearnApply(v => !v)}
              style={btn(learnApply ? "linear-gradient(160deg, #1f5e40, #174530)" : "#232d47", { fontSize: 13, padding: "12px 8px", marginTop: 10, border: `1px solid ${learnApply ? C.ok : C.line}` })}>
              {learnApply ? "✓ 学習パラメータをAIに適用中(タップでOFF)" : "学習パラメータの適用: OFF(タップでON)"}
            </button>
          </div>

          {learned ? (
            <div style={panel}>
              <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>📐 学習済みパラメータ</div>
              <div style={{ fontSize: 13, lineHeight: 2.1 }}>
                <div>🎯 サーブ時得点率: <b style={{ color: C.warn }}>{learned.pServe !== null ? `${Math.round(learned.pServe * 100)}%` : "データ不足(30ラリー以上必要)"}</b>{learned.pServe !== null && <span style={{ fontSize: 10, color: C.dim }}> → 勝率予測に適用</span>}</div>
                <div>🛡 レシーブ時得点率: <b style={{ color: C.warn }}>{learned.pReceive !== null ? `${Math.round(learned.pReceive * 100)}%` : "—"}</b></div>
                <div>⏱ TO後3本の立て直し率: <b style={{ color: C.warn }}>{learned.toRate !== null ? `${Math.round(learned.toRate * 100)}%` : "データ不足"}</b>{learned.toRate !== null && <span style={{ fontSize: 10, color: C.dim }}> → 分断係数 {learned.toFactor.toFixed(2)}</span>}</div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 900, color: C.dim, margin: "10px 0 6px" }}>⚙️ W_t 重みの自動補正</div>
              {learned.calib.length === 0 ? (
                <div style={{ fontSize: 12, color: C.dim }}>連続失点に偏るプレーはまだ検出されていません。</div>
              ) : learned.calib.map((c, i) => (
                <div key={i} style={{ fontSize: 12, lineHeight: 1.9 }}>
                  ・{c.play}: {c.current.toFixed(1)} → <b style={{ color: C.warn }}>{c.suggested.toFixed(1)}</b> <span style={{ fontSize: 10, color: C.dim }}>({c.note})</span>
                </div>
              ))}
              {learned.byServerN >= 12 && (<>
                <div style={{ fontSize: 11, fontWeight: 900, color: C.dim, margin: "10px 0 6px" }}>🔄 サーブ順別 得失点差(自チーム)</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
                  {learned.byServer.map((s, i) => (
                    <div key={i} style={{ background: "#0A0F1E", borderRadius: 10, padding: "8px 2px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, fontWeight: 900, color: C.dim }}>{roster.us[i].name}</div>
                      <div style={{ fontFamily: "Oswald", fontSize: 14, color: s.won - s.lost >= 0 ? C.us : C.them }}>{s.won - s.lost >= 0 ? "+" : ""}{s.won - s.lost}</div>
                    </div>
                  ))}
                </div>
              </>)}
            </div>
          ) : (
            <div style={{ ...panel, fontSize: 12, color: C.dim, lineHeight: 1.8 }}>
              まだ学習データがありません(10ラリー以上で学習開始)。<br />
              📺 観戦・学習モードでプロや春高の試合を記録するか、下のインポートから試合JSONを追加してください。
            </div>
          )}

          <div style={{ ...panel, border: `1px solid ${C.warn}44` }}>
            <div style={{ fontSize: 12, color: C.warn, fontWeight: 800, marginBottom: 10 }}>🎓 AI戦術レポート(学習データ→戦術知見)</div>
            {!scoutRep ? (
              <button style={btn(`linear-gradient(160deg, ${C.warn}, #e0a020)`, { color: "#1a1a1a", fontSize: 15, padding: "14px 8px" })} onClick={genScout} disabled={scoutLoading || !learned}>
                {scoutLoading ? "🎓 分析中…" : learned ? "🎓 学習データから戦術レポートを生成" : "学習データが必要です"}
              </button>
            ) : (
              <div style={{ animation: "slideUp .3s" }}>
                <div style={{ fontSize: 16, fontWeight: 900, color: C.warn, marginBottom: 8 }}>『{scoutRep.title}』</div>
                {scoutRep.points.map((p, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.8, display: "flex", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontFamily: "Oswald", color: C.warn }}>{i + 1}</span><span>{p}</span>
                  </div>
                ))}
                <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "8px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12, marginTop: 6 }} onClick={() => setScoutRep(null)}>↻ 再生成</button>
              </div>
            )}
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>💾 データ管理</div>
            <label style={{ ...btn("#232d47", { fontSize: 13, padding: "12px 8px", display: "block", textAlign: "center", marginBottom: 8 }) }}>
              📥 試合JSONをインポート(プロ・春高の記録など)
              <input type="file" accept=".json,application/json" onChange={handleImport} style={{ display: "none" }} />
            </label>
            {importMsg && <div style={{ fontSize: 11, fontWeight: 800, color: importMsg.startsWith("✓") ? C.ok : C.warn, marginBottom: 8, textAlign: "center" }}>{importMsg}</div>}
            <button style={btn("#232d47", { fontSize: 13, padding: "12px 8px", marginBottom: 10 })} onClick={exportLearn} disabled={!learnEntries.length}>
              💾 学習データ一式をエクスポート
            </button>
            {learnEntries.length === 0 ? (
              <div style={{ fontSize: 11, color: C.dim }}>保存された試合はありません。</div>
            ) : learnEntries.map(e => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "7px 0", borderTop: `1px solid ${C.line}` }}>
                <span style={{ fontSize: 9, fontWeight: 900, padding: "3px 8px", borderRadius: 8, background: e.source === "own" ? `${C.us}22` : "#B66EFF22", color: e.source === "own" ? C.us : "#B66EFF" }}>
                  {e.source === "own" ? "自チーム" : "外部"}
                </span>
                <span style={{ flex: 1, fontWeight: 700 }}>{e.label}</span>
                <span style={{ color: C.dim, fontSize: 10 }}>{(e.sets || []).map(s => `${s.us}-${s.them}`).join(" / ")}</span>
                <button onClick={() => deleteEntry(e.id)} style={{ background: "none", border: "none", color: C.them, cursor: "pointer", fontSize: 13 }}>🗑</button>
              </div>
            ))}
            <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.7 }}>
              インポート形式: このアプリの「試合データをエクスポート」JSON、または学習バンドルJSON。別端末で春高等を記録→エクスポート→ここで取り込み、の運用ができます。
            </div>
          </div>
        </>) : mode === "form" ? (<>
          {/* ============ ★AIフォームラボ(リアルタイム骨格解析) ============ */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>🎥 AIフォームラボ</div>
            <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "6px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }} onClick={() => setMode("home")}>← ホーム</button>
          </div>
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.7 }}>
            カメラまたは動画から骨格を<b style={{ color: C.txt }}>端末内でリアルタイムAI解析</b>。オーバーハンドスイングを自動検出して採点します。プロの動画を分析して「お手本」に登録すれば、自分のフォームと数値で比較できます。
          </div>

          <div style={panel}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center" }}>
              {["スパイク", "サーブ"].map(k => (
                <button key={k} onClick={() => setFormKind(k)}
                  style={btn(formKind === k ? `linear-gradient(160deg, ${C.us}, #2456c9)` : "#232d47", { padding: "10px 8px", fontSize: 13, border: formKind === k ? `2px solid ${C.warn}` : "2px solid transparent" })}>
                  {k === "スパイク" ? "💥" : "🎯"} {k}
                </button>
              ))}
              <input value={heightCm} onChange={e => setHeightCm(e.target.value.replace(/[^0-9]/g, ""))} maxLength={3} placeholder="身長cm"
                style={{ width: 70, background: "#0A0F1E", border: `1px solid ${C.line}`, borderRadius: 10, color: C.txt, padding: "10px 8px", fontSize: 13, fontWeight: 700, fontFamily: "'Noto Sans JP', sans-serif", outline: "none", textAlign: "center" }} />
            </div>
            {/* ★検出精度モード(モデル切替) */}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr 1fr", gap: 6, alignItems: "center", marginTop: 8 }}>
              <span style={{ fontSize: 10, color: C.dim, fontWeight: 800, paddingRight: 4 }}>検出精度</span>
              {[["lite", "軽量"], ["full", "標準"], ["heavy", "高精度"]].map(([m, lbl]) => (
                <button key={m} onClick={() => setFormModel(m)} disabled={formStatus !== "idle"}
                  style={btn(formModel === m ? "linear-gradient(160deg, #1f5e40, #174530)" : "#232d47", {
                    padding: "8px 4px", fontSize: 11,
                    border: formModel === m ? `1px solid ${C.ok}` : "1px solid transparent",
                    opacity: formStatus !== "idle" ? 0.5 : 1,
                  })}>
                  {lbl}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>標準=推奨。高精度はPC向き(スマホでは動作が重くなる場合あり)。停止中のみ変更できます。</div>
          </div>

          <div style={{ ...panel, padding: 10 }}>
            <div style={{ position: "relative", borderRadius: 14, overflow: "hidden", background: "#000", minHeight: 180 }}>
              <video ref={videoRef} playsInline muted style={{ width: "100%", display: "block", transform: mirror ? "scaleX(-1)" : "none" }} />
              <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", transform: mirror ? "scaleX(-1)" : "none" }} />
              <span style={{ position: "absolute", top: 8, left: 8, fontSize: 10, fontWeight: 900, padding: "4px 10px", borderRadius: 8, background: "rgba(10,15,30,.8)", color: formStatus === "running" ? C.ok : formStatus === "loading" ? C.warn : C.dim }}>
                {formStatus === "running" ? "● 解析中(端末内処理)" : formStatus === "loading" ? "◌ AIエンジン読込中…" : "○ 停止中"}
              </span>
              {formStatus === "running" && trackQuality && (
                <span style={{ position: "absolute", top: 8, right: 8, fontSize: 10, fontWeight: 900, padding: "4px 10px", borderRadius: 8, background: "rgba(10,15,30,.8)", color: trackQuality === "good" ? C.ok : C.warn }}>
                  {trackQuality === "good" ? "🟢 全身検出中" : "🟠 全身が映っていません"}
                </span>
              )}
              {formStatus === "idle" && !formErr && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36 }}>🤸</div>
              )}
            </div>
            {formErr && <div style={{ fontSize: 11, fontWeight: 800, color: C.them, marginTop: 8, lineHeight: 1.7 }}>⚠ {formErr}</div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <button style={btn(`linear-gradient(160deg, ${C.us}, #2456c9)`, { fontSize: 13, padding: "13px 6px" })} onClick={() => startForm("camera")} disabled={formStatus === "loading"}>
                📷 カメラで分析
              </button>
              <label style={btn("#232d47", { fontSize: 13, padding: "13px 6px", textAlign: "center", display: "block" })}>
                📁 動画ファイルを分析
                <input type="file" accept="video/*" style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) startForm("file", f); e.target.value = ""; }} />
              </label>
            </div>
            {formStatus === "running" && (
              <div style={{ display: "grid", gridTemplateColumns: formSource === "camera" ? "1fr 1fr" : "1fr", gap: 8, marginTop: 8 }}>
                {formSource === "camera" && (
                  <button style={btn("#232d47", { fontSize: 13, padding: "11px 6px" })}
                    onClick={() => { const next = camFacing === "user" ? "environment" : "user"; setCamFacing(next); startForm("camera", null, next); }}>
                    🔄 {camFacing === "user" ? "外カメラへ" : "内カメラへ"}切替
                  </button>
                )}
                <button style={btn("#45202a", { fontSize: 13, padding: "11px 6px", border: `1px solid ${C.them}66` })} onClick={stopForm}>⏹ 停止</button>
              </div>
            )}
            <div style={{ fontSize: 10, color: C.dim, marginTop: 8, lineHeight: 1.7 }}>
              💡 側面から全身(頭〜足首)が映る位置にカメラを置いてください。🔒 映像は端末内で処理され、外部には一切送信されません。
            </div>
          </div>

          {liveM && (
            <div style={panel}>
              <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 8 }}>📡 ライブ計測</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, textAlign: "center" }}>
                {[
                  ["打点", `${liveM.wristH > 0 ? "+" : ""}${Math.round(liveM.wristH * 100)}%`, liveM.wristH > 0.1 ? C.ok : C.dim],
                  ["肘", `${liveM.elbow}°`, liveM.elbow > 150 ? C.ok : C.dim],
                  ["膝", `${liveM.knee}°`, liveM.knee < 140 ? C.ok : C.dim],
                  ["跳躍", `${Math.round(liveM.jump * 100)}%`, liveM.jump > 0.06 ? C.ok : C.dim],
                ].map(([lbl, v, col]) => (
                  <div key={lbl} style={{ background: "#0A0F1E", borderRadius: 12, padding: "8px 4px" }}>
                    <div style={{ fontFamily: "Oswald", fontSize: 18, color: col }}>{v}</div>
                    <div style={{ fontSize: 9, color: C.dim }}>{lbl}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={panel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: C.dim, fontWeight: 800 }}>🏐 検出スイング: {reps.length}本</span>
              {repAvg && <span style={{ fontFamily: "Oswald", fontSize: 22, color: repAvg.score >= 70 ? C.ok : repAvg.score >= 45 ? C.warn : C.them }}>平均 {Math.round(repAvg.score)}点</span>}
            </div>
            {reps.length === 0 ? (
              <div style={{ fontSize: 12, color: C.dim }}>カメラか動画を開始してスイングすると、自動で1本ずつ検出・採点されます。</div>
            ) : (<>
              {[...reps].reverse().slice(0, 8).map((r, i) => (
                <div key={r.t} style={{ display: "flex", gap: 8, fontSize: 11, padding: "6px 0", borderTop: i ? `1px solid ${C.line}` : "none", alignItems: "center" }}>
                  <span style={{ fontFamily: "Oswald", color: C.dim, width: 24 }}>#{reps.length - i}</span>
                  <span style={{ fontFamily: "Oswald", fontSize: 16, width: 44, color: r.score >= 70 ? C.ok : r.score >= 45 ? C.warn : C.them }}>{r.score}点</span>
                  <span style={{ color: C.dim }}>打点+{Math.round(r.maxWristH * 100)}% / 肘{Math.round(r.elbowAtMax)}° / 膝{Math.round(r.minKnee)}° / 跳{Math.round(r.maxJump * 100)}%{jumpCmOf(r.maxJump)}</span>
                </div>
              ))}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
                <button style={btn("linear-gradient(160deg, #1f5e40, #174530)", { fontSize: 12, padding: "11px 6px", border: `1px solid ${C.ok}` })} onClick={addFormRef}>
                  ⭐ この平均を{formKind}のお手本に登録
                </button>
                <button style={btn("#232d47", { fontSize: 12, padding: "11px 6px" })} onClick={() => { setReps([]); setFormAdvice(null); }}>
                  🗑 スイングをクリア
                </button>
              </div>
            </>)}
          </div>

          {/* ★お手本リスト(追加・削除・ON/OFF) */}
          <div style={{ ...panel, border: `1px solid ${C.warn}44` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: C.warn, fontWeight: 800 }}>⭐ お手本リスト</span>
              {presetsMissing && (
                <button onClick={restorePresets} style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 8, padding: "4px 10px", cursor: "pointer", fontWeight: 700, fontSize: 10 }}>
                  ↺ プリセットを復元
                </button>
              )}
            </div>
            {formRefs.length === 0 ? (
              <div style={{ fontSize: 12, color: C.dim, padding: "6px 0" }}>お手本がありません。スイングを検出して「お手本に登録」するか、プリセットを復元してください。</div>
            ) : formRefs.map(r => (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderTop: `1px solid ${C.line}` }}>
                <button onClick={() => toggleFormRef(r.id)} title={r.enabled ? "比較に使用中" : "OFF"}
                  style={{ width: 40, height: 22, borderRadius: 11, border: "none", cursor: "pointer", position: "relative", background: r.enabled ? C.ok : "#232d47", flexShrink: 0, padding: 0 }}>
                  <span style={{ position: "absolute", top: 2, left: r.enabled ? 20 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
                </button>
                <span style={{ fontSize: 9, fontWeight: 900, padding: "3px 8px", borderRadius: 8, flexShrink: 0, background: r.kind === "スパイク" ? `${C.us}22` : `${C.warn}22`, color: r.kind === "スパイク" ? C.us : C.warn }}>
                  {r.kind === "スパイク" ? "💥" : "🎯"} {r.kind}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 800, fontSize: 12 }}>{r.label}{r.builtin && <span style={{ fontSize: 9, color: C.dim, fontWeight: 700 }}>(推定値)</span>}</span><br />
                  <span style={{ color: C.dim, fontSize: 10 }}>打点+{Math.round(r.hit * 100)}% / 肘{Math.round(r.elbow)}° / 膝{Math.round(r.knee)}° / 跳{Math.round(r.jump * 100)}%</span>
                </span>
                <button onClick={() => deleteFormRef(r.id)} style={{ background: "none", border: "none", color: C.them, cursor: "pointer", fontSize: 13, flexShrink: 0 }}>🗑</button>
              </div>
            ))}
            <div style={{ fontSize: 10, color: C.dim, marginTop: 6, lineHeight: 1.7 }}>
              ONのお手本が現在の種目と一致すると下に比較が出ます(同じ種目でONは1つ)。プロの動画を「📁 動画ファイルを分析」→「⭐ お手本に登録」で実測のお手本を追加できます。プリセットは公開データからの推定値です。
            </div>
            {activeRef && (
              <div style={{ marginTop: 10, background: "#0A0F1E", borderRadius: 14, padding: 12 }}>
                <div style={{ fontSize: 11, color: C.warn, fontWeight: 800, marginBottom: 8 }}>📊 「{activeRef.label}」との比較</div>
                {!repAvg ? (
                  <div style={{ fontSize: 11, color: C.dim }}>スイングを検出すると差分が表示されます。</div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, textAlign: "center" }}>
                    {[
                      ["打点", (repAvg.hit - activeRef.hit) * 100, "%"],
                      ["肘", repAvg.elbow - activeRef.elbow, "°"],
                      ["膝", repAvg.knee - activeRef.knee, "°", true],
                      ["跳躍", (repAvg.jump - activeRef.jump) * 100, "%"],
                    ].map(([lbl, d, unit, lowerBetter]) => {
                      const good = lowerBetter ? d <= 0 : d >= 0;
                      return (
                        <div key={lbl} style={{ background: "#161E33", borderRadius: 12, padding: "8px 4px" }}>
                          <div style={{ fontFamily: "Oswald", fontSize: 16, color: good ? C.ok : C.them }}>{d >= 0 ? "+" : ""}{Math.round(d)}{unit}</div>
                          <div style={{ fontSize: 9, color: C.dim }}>{lbl}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <div style={{ ...panel, border: `1px solid ${C.us}44` }}>
            <div style={{ fontSize: 12, color: C.us, fontWeight: 800, marginBottom: 10 }}>🤖 AIフォームコーチ</div>
            {!formAdvice ? (
              <button style={btn(`linear-gradient(160deg, ${C.us}, #2456c9)`, { fontSize: 14, padding: "13px 8px" })} onClick={genFormAdvice} disabled={!repAvg || formAdviceLoading}>
                {formAdviceLoading ? "🤖 フォームを分析中…" : repAvg ? "🤖 計測データから改善アドバイスをもらう" : "スイングを検出すると利用できます"}
              </button>
            ) : (
              <div style={{ animation: "slideUp .3s" }}>
                {formAdvice.map((p, i) => (
                  <div key={i} style={{ fontSize: 13, lineHeight: 1.8, display: "flex", gap: 8, marginBottom: 8 }}>
                    <span style={{ fontFamily: "Oswald", color: C.us }}>{i + 1}</span><span>{p}</span>
                  </div>
                ))}
                <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "8px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }} onClick={() => setFormAdvice(null)}>↻ 再分析</button>
              </div>
            )}
          </div>
        </>) : mode === "setup" ? (<>
          {/* ============ 初期ローテーション設定(コート型UI) ============ */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>{matchKind === "scout" ? "📺" : "🏐"} SET {setNo} — 初期ローテーション設定</div>
            {setNo === 1 && archived.length === 0 && (
              <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "6px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }} onClick={goHome}>← ホーム</button>
            )}
          </div>
          {matchKind === "scout" && (
            <div style={{ background: "#B66EFF18", border: "1px solid #B66EFF55", borderRadius: 16, padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "#d9b8ff", lineHeight: 1.8 }}>
              📺 観戦・学習モード: 注目するチームを「自チーム」として記録してください。試合終了時に自動でAI学習データに追加されます(TOのAI警告は出ません)。
            </div>
          )}
          <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.7 }}>
            デフォルトは<b style={{ color: C.txt }}>対角配置</b>(P1-P4/P2-P5/P3-P6: レフト⇔レフト、センター⇔センター、セッター⇔ライト)。カードを2枚タップすると入れ替えできます。P1が最初のサーバーです。
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 8 }}>最初のサーブ権</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {["us", "them"].map(t => (
                <button key={t} onClick={() => setFirstServe(t)}
                  style={btn(firstServe === t ? (t === "us" ? `linear-gradient(160deg, ${C.us}, #2456c9)` : `linear-gradient(160deg, ${C.them}, #c22a20)`) : "#232d47", {
                    padding: "14px 8px", fontSize: 15,
                    border: firstServe === t ? `2px solid ${C.warn}` : "2px solid transparent",
                  })}>
                  {t === "us" ? "🔵 自チーム" : "🔴 相手チーム"}{firstServe === t ? " 🏐" : ""}
                </button>
              ))}
            </div>
          </div>

          {/* ★セットの先取点数(15点制・21点制などに変更可能) */}
          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 8 }}>
              セットの先取点数(2点差制)
              {setNo === 5 && <span style={{ color: C.warn, marginLeft: 8 }}>💡 第5セットは15点制が一般的です</span>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "center" }}>
              {[15, 21, 25].map(t => (
                <button key={t} onClick={() => setSetTarget(t)}
                  style={btn(setTarget === t ? `linear-gradient(160deg, ${C.us}, #2456c9)` : "#232d47", {
                    padding: "12px 6px", fontSize: 16, fontFamily: "Oswald",
                    border: setTarget === t ? `2px solid ${C.warn}` : "2px solid transparent",
                  })}>
                  {t}点
                </button>
              ))}
              <input value={setTarget || ""} inputMode="numeric" placeholder="自由"
                onChange={e => { const v = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10); setSetTarget(isNaN(v) ? 0 : Math.min(99, v)); }}
                style={{
                  width: 64, background: "#0A0F1E", borderRadius: 10, color: C.txt, padding: "12px 8px",
                  fontSize: 16, fontWeight: 700, fontFamily: "Oswald", outline: "none", textAlign: "center",
                  border: [15, 21, 25].includes(setTarget) ? `1px solid ${C.line}` : `2px solid ${C.warn}`,
                }} />
            </div>
            <div style={{ fontSize: 10, color: C.dim, marginTop: 6 }}>勝率予測・AIのタイムアウト判定・セットポイント表示すべてがこの点数に合わせて動きます。</div>
          </div>

          {renderCourtSetup("us")}
          {renderCourtSetup("them")}

          {/* ★AIローテ最適化(学習データより) */}
          {matchKind === "match" && learnApply && learned && learned.byServerN >= 24 && (() => {
            const best = bestServeOrder(lineup.us, learned.byServer);
            return (
              <div style={{ ...panel, border: `1px solid ${C.ok}44` }}>
                <div style={{ fontSize: 12, color: C.ok, fontWeight: 800, marginBottom: 8 }}>🧠 AIローテ最適化(過去{learned.byServerN}ラリーの学習より)</div>
                {best.offset === 0 ? (
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>✓ 現在のサーブ順は過去データ上ベストの並びです。</div>
                ) : (<>
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <b style={{ color: C.warn }}>{roster.us[lineup.us[best.offset]].name}</b> をP1(最初のサーバー)にする並びの方が、序盤の期待得失点が有利です。
                  </div>
                  <button style={btn("linear-gradient(160deg, #1f5e40, #174530)", { fontSize: 13, padding: "12px 8px", marginTop: 8, border: `1px solid ${C.ok}` })}
                    onClick={() => setLineup(l => ({ ...l, us: l.us.map((_, i) => l.us[(best.offset + i) % 6]) }))}>
                    ✓ この並びに回す(対角は維持)
                  </button>
                </>)}
                <div style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>※サーブ順の開始位置だけを回すため、対角関係は崩れません。</div>
              </div>
            );
          })()}

          <button style={btn(`linear-gradient(160deg, ${C.us}, #2456c9)`, { fontSize: 20, fontWeight: 900, boxShadow: `0 6px 24px ${C.us}55` })}
            onPointerDown={press} onPointerUp={release} onPointerLeave={release}
            onClick={() => { setSelSlot(null); setSetTarget(t => t >= 5 ? t : SET_TARGET); setMode("game"); }}>
            {matchKind === "scout" ? "📺 記録開始!" : `🏐 SET ${setNo} 開始!`}{setTarget >= 5 ? `(${setTarget}点先取)` : ""}
          </button>
        </>) : mode === "game" ? (<>
          {/* ===== ヘッダー ===== */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: C.dim, fontWeight: 700 }}>
              🏐 サーブ: <span style={{ color: rot.serving === "us" ? C.us : C.them, fontWeight: 900 }}>
                {rot.serving === "us" ? "自チーム" : "相手"} {serverOf(rot.serving).name}
              </span>(P1)
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {matchKind === "scout" && (
                <span style={{ fontSize: 10, fontWeight: 900, color: "#B66EFF", border: "1px solid #B66EFF55", borderRadius: 8, padding: "5px 8px" }}>📺 学習記録中</span>
              )}
              <button style={{ background: voiceOn ? C.warn : "none", border: `1px solid ${voiceOn ? C.warn : C.line}`, color: voiceOn ? "#1a1a1a" : C.dim, borderRadius: 10, padding: "6px 10px", cursor: "pointer", fontWeight: 900, fontSize: 12 }}
                onClick={() => setVoiceOn(v => !v)} title="AI指示の音声読み上げ">
                {voiceOn ? "🔊 音声ON" : "🔇 音声"}
              </button>
              <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "6px 10px", cursor: "pointer", fontWeight: 700, fontSize: 12 }}
                onClick={() => setMode("setup")} disabled={rallies.length > 0}>
                {rallies.length > 0 ? "🔒" : "⚙"} ローテ
              </button>
            </div>
          </div>

          {/* ===== スコアボード ===== */}
          <div style={{ ...panel, padding: "16px 18px", boxShadow: `0 0 40px ${auraColor}`, transition: "box-shadow 1s" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 11, color: C.us, fontWeight: 800, letterSpacing: 3 }}>自チーム{rot.serving === "us" && " 🏐"}</div>
                <div key={`u${us}`} style={{ fontFamily: "Oswald", fontSize: 58, fontWeight: 700, lineHeight: 1, animation: "pop .45s", textShadow: `0 0 24px ${C.us}66` }}>{us}</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "Oswald", color: C.dim, fontSize: 18 }}>SET {setNo}</div>
                <div style={{ fontSize: 9, color: C.dim, fontWeight: 700 }}>{setTarget}点先取</div>
                <div style={{ fontFamily: "Oswald", fontSize: 13, color: C.dim }}>
                  <span style={{ color: C.us }}>{setsWon.us}</span> - <span style={{ color: C.them }}>{setsWon.them}</span>
                </div>
                <div style={{ fontSize: 22, animation: "floatBall 2.4s ease-in-out infinite" }}>🏐</div>
                <div style={{ display: "flex", gap: 4, justifyContent: "center", marginTop: 4 }}>
                  {Array.from({ length: MAX_TIMEOUTS }, (_, i) => (
                    <span key={i} style={{ width: 14, height: 6, borderRadius: 3, background: i < timeoutsLeft ? C.warn : C.line }} />
                  ))}
                </div>
                <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>TO残り</div>
              </div>
              <div style={{ textAlign: "center", flex: 1 }}>
                <div style={{ fontSize: 11, color: C.them, fontWeight: 800, letterSpacing: 3 }}>相手{rot.serving === "them" && " 🏐"}</div>
                <div key={`t${them}`} style={{ fontFamily: "Oswald", fontSize: 58, fontWeight: 700, lineHeight: 1, animation: "pop .45s", textShadow: `0 0 24px ${C.them}66` }}>{them}</div>
              </div>
            </div>

            {/* ★リアルタイム勝率(モンテカルロ予測) */}
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim, marginBottom: 4 }}>
                <span>📈 セット獲得確率(AI予測)</span>
                <span style={{ fontFamily: "Oswald", fontSize: 15, fontWeight: 700, color: wp >= 0.5 ? C.us : C.them }}>{Math.round(wp * 100)}%</span>
              </div>
              <div style={{ height: 12, borderRadius: 6, background: "#3a1d22", overflow: "hidden", position: "relative" }}>
                <div style={{ height: "100%", width: `${wp * 100}%`, background: `linear-gradient(90deg, #2456c9, ${C.us})`, borderRadius: 6, transition: "width .8s cubic-bezier(.2,.9,.3,1)" }} />
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1.5, background: "rgba(255,255,255,.5)" }} />
              </div>
            </div>

            {(isDeuce || setPointUs || setPointThem) && (
              <div key={`${us}-${them}`} style={{ marginTop: 8, textAlign: "center", fontWeight: 900, fontSize: 14, animation: "comboPop .4s", color: isDeuce ? C.warn : setPointUs ? C.us : C.them }}>
                {isDeuce ? "⚡ デュース!2点差を先に取った方がセット獲得" :
                  setPointUs ? "🏆 セットポイント!あと1点で獲得" : "🛡 相手のセットポイント…踏ん張りどころ"}
              </div>
            )}

            {Math.abs(streakDisp) >= 2 && !isDeuce && !setPointUs && !setPointThem && (
              <div key={streakDisp} style={{ marginTop: 8, textAlign: "center", fontWeight: 900, fontSize: 15, color: streakDisp > 0 ? C.warn : C.them, animation: "comboPop .4s" }}>
                {streakDisp > 0 ? `🔥 ${streakDisp}連続得点中!ビッグウェーブ!` : `🚨 ${-streakDisp}連続失点中…`}
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim, marginBottom: 4 }}>
                <span>相手の流れ</span>
                <span style={{ fontFamily: "Oswald", fontSize: 14 }}>M = {m.toFixed(2)}</span>
                <span>自チームの流れ</span>
              </div>
              <div style={{ position: "relative", height: 26, borderRadius: 13, overflow: "hidden", background: `linear-gradient(90deg, ${C.them}, #5a4070 50%, ${C.us})` }}>
                <div style={{ position: "absolute", inset: 0, opacity: .25, background: "repeating-linear-gradient(115deg, transparent 0 14px, rgba(255,255,255,.5) 14px 28px)", animation: "marquee 1.4s linear infinite" }} />
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: "rgba(255,255,255,.6)" }} />
                <div style={{ position: "absolute", top: 1, left: `calc(${pct}% - 12px)`, width: 24, height: 24, borderRadius: "50%", background: "#fff", border: `5px solid ${m < 0 ? C.them : C.us}`, transition: "left .6s cubic-bezier(.2,1.4,.3,1)", boxShadow: `0 0 14px ${m < 0 ? C.them : C.us}` }} />
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim, marginBottom: 4 }}>
                <span>🤖 AIコーチの警戒度</span>
                <span style={{ fontWeight: 900, color: threatColor }}>{judging ? "判定中…" : threatLabel}</span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: "#0A0F1E", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${threatPct}%`, background: threatColor, borderRadius: 4, transition: "width .6s, background .6s", animation: judging ? "pulse .8s infinite" : "none" }} />
              </div>
              {threat.factors.length > 0 && (
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {threat.factors.map((f, i) => (
                    <span key={i} style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 8, background: f.v >= 0 ? "rgba(255,74,61,.15)" : "rgba(70,214,140,.15)", color: f.v >= 0 ? "#ff8c84" : C.ok }}>
                      {f.v >= 0 ? "▲" : "▼"} {f.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ★鬼門ローテ事前警告 */}
          {weakRotNow && !setEnd && (
            <div style={{ background: "rgba(255,200,61,.1)", border: `1px solid ${C.warn}55`, borderRadius: 16, padding: "10px 14px", fontSize: 12, fontWeight: 700, color: C.warn, animation: "slideUp .3s" }}>
              ⚠ 鬼門のR{curRot + 1}に入りました(今日 {curRotStat.won}得点-{curRotStat.lost}失点)。サーブカットの位置取りを全員で声出し確認!
            </div>
          )}

          {verdict && !verdict.alert && (
            <div style={{ background: "linear-gradient(160deg, #1a2a22, #14211c)", border: "1px solid #2f5a44", borderRadius: 18, padding: "12px 16px", animation: "slideUp .3s", fontSize: 13 }}>
              <div style={{ fontWeight: 900, color: C.ok, marginBottom: 4 }}>
                🤖 AIコーチ判定: タイムアウトはまだ温存 {verdict.offline && <span style={{ color: C.dim, fontWeight: 500 }}>(オフライン判定)</span>}
              </div>
              <div style={{ color: C.dim, lineHeight: 1.6 }}>理由: {verdict.reason}</div>
              <div style={{ marginTop: 6, lineHeight: 1.7 }}>📣 声かけ案: {verdict.advice}</div>
            </div>
          )}

          {/* ===== 入力 ===== */}
          <div style={{ ...panel, minHeight: 240 }}>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 10, fontWeight: 800, display: "flex", justifyContent: "space-between" }}>
              <span>
                {step === 0 ? "① 結果は?" : step === 1 ? "② どんなプレー?" :
                  `③ ${targetTeamFor(pending) === "us" ? (pending.e === 1 ? "誰が決めた?" : "誰のエラー?") : (pending.e === 1 ? "相手の誰のエラー?" : "相手の誰にやられた?")}`}
              </span>
              <span style={{ display: "flex", gap: 4 }}>
                {[0, 1, 2].map(i => <span key={i} style={{ width: 18, height: 6, borderRadius: 3, background: i <= step ? C.warn : C.line, transition: "background .2s" }} />)}
              </span>
            </div>
            <div key={step} style={{ animation: "slideUp .22s ease-out" }}>
              {step === 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <button style={btn(`linear-gradient(160deg, ${C.us}, #2456c9)`, { padding: "44px 8px", fontSize: 27, fontWeight: 900, boxShadow: `0 6px 22px ${C.us}55` })} onPointerDown={press} onPointerUp={release} onPointerLeave={release} onClick={() => tap1(1)}>🙌<br />得点</button>
                  <button style={btn(`linear-gradient(160deg, ${C.them}, #c22a20)`, { padding: "44px 8px", fontSize: 27, fontWeight: 900, boxShadow: `0 6px 22px ${C.them}55` })} onPointerDown={press} onPointerUp={release} onPointerLeave={release} onClick={() => tap1(-1)}>😣<br />失点</button>
                </div>
              )}
              {step === 1 && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {PLAYS[pending.e === 1 ? "win" : "lose"].map(p => (
                    <button key={p.id} style={btn(pending.e === 1 ? `linear-gradient(160deg, ${C.us}, #2456c9)` : `linear-gradient(160deg, ${C.them}, #c22a20)`)} onPointerDown={press} onPointerUp={release} onPointerLeave={release} onClick={() => tap2(p)}>
                      <span style={{ fontSize: 24 }}>{p.emoji}</span><br />{p.label}
                      <div style={{ fontSize: 11, opacity: .8, fontWeight: 600 }}>
                        {p.autoServer ? `🏐 ${serverOf(p.autoServer).name} を自動記録` : `インパクト ×${p.w.toFixed(1)}`}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {step === 2 && <CourtSelect team={targetTeamFor(pending)} onPick={tap3} />}
            </div>
            {step > 0 && (
              <button style={{ marginTop: 10, background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 12, padding: "9px 16px", width: "100%", cursor: "pointer", fontWeight: 700 }} onClick={() => { setStep(0); setPending({}); }}>← やり直す</button>
            )}
          </div>

          {/* ===== 履歴 ===== */}
          <div style={panel}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: C.dim, fontWeight: 800 }}>ラリー履歴</span>
              <span style={{ display: "flex", gap: 12 }}>
                {matchKind === "scout" && (
                  <button onClick={() => setLog(l => [...l, { type: "timeout", t: Date.now() }])}
                    style={{ background: "none", border: "none", color: C.warn, fontWeight: 800, cursor: "pointer", fontSize: 12 }}>⏱ TO発生を記録</button>
                )}
                <button onClick={undo} disabled={!log.length} style={{ background: "none", border: "none", color: log.length ? C.warn : C.line, fontWeight: 800, cursor: "pointer", fontSize: 12 }}>↩ 1つ戻す</button>
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column-reverse", gap: 6, maxHeight: 120, overflowY: "auto" }}>
              {!log.length && <div style={{ color: C.dim, fontSize: 13 }}>最初のラリーを記録して、流れを見える化しよう 🏐</div>}
              {log.map((r, i) => r.type === "timeout" ? (
                <div key={i} style={{ fontSize: 13, color: C.warn, fontWeight: 800 }}>⏱ タイムアウト</div>
              ) : (
                <div key={i} style={{ fontSize: 13, display: "flex", gap: 8 }}>
                  <span style={{ color: r.e === 1 ? C.us : C.them, fontWeight: 900 }}>{r.e === 1 ? "+" : "−"}</span>
                  <span>{r.play}</span><span style={{ color: C.dim }}>{labelOf(r.target)}</span>
                  <span style={{ marginLeft: "auto", color: C.dim, fontFamily: "Oswald" }}>{(r.w * r.e).toFixed(1)}</span>
                </div>
              ))}
            </div>
          </div>

          {allSets.length > 0 && (
            <button style={btn("linear-gradient(160deg, #33405f, #232d47)", { fontSize: 15, padding: "14px 8px" })} onClick={() => setMode("report")}>
              📊 ここまでの分析レポートを見る
            </button>
          )}
        </>) : (<>
          {/* ============ 分析レポート ============ */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>📊 試合分析レポート</div>
            <button style={{ background: "none", border: `1px solid ${C.line}`, color: C.dim, borderRadius: 10, padding: "6px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }} onClick={() => setMode(rallies.length ? "game" : "setup")}>← 試合に戻る</button>
          </div>

          <div style={{ ...panel, textAlign: "center" }}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800 }}>セットカウント</div>
            <div style={{ fontFamily: "Oswald", fontSize: 44, fontWeight: 700 }}>
              <span style={{ color: C.us }}>{setsWon.us}</span><span style={{ color: C.dim }}> - </span><span style={{ color: C.them }}>{setsWon.them}</span>
            </div>
          </div>

          {/* ★AI実況ハイライト */}
          <div style={{ ...panel, border: `1px solid ${C.warn}44` }}>
            <div style={{ fontSize: 12, color: C.warn, fontWeight: 800, marginBottom: 10 }}>🎙 AI実況ハイライト</div>
            {!story ? (
              <button style={btn(`linear-gradient(160deg, ${C.warn}, #e0a020)`, { color: "#1a1a1a", fontSize: 15, padding: "14px 8px" })} onClick={genStory} disabled={storyLoading || allSets.length === 0}>
                {storyLoading ? "🎙 実況を生成中…" : "🎙 今日の試合をAI実況で振り返る"}
              </button>
            ) : (
              <div style={{ animation: "slideUp .3s" }}>
                <div style={{ fontSize: 17, fontWeight: 900, marginBottom: 8, color: C.warn }}>『{story.headline}』</div>
                <div style={{ fontSize: 13, lineHeight: 2 }}>{story.story}</div>
              </div>
            )}
            {turningPoints.length > 0 && (<>
              <div style={{ fontSize: 11, fontWeight: 900, color: C.dim, margin: "12px 0 6px" }}>⚡ ターニングポイント(勝率変動 Top3)</div>
              {turningPoints.map((t, i) => (
                <div key={i} style={{ fontSize: 12, lineHeight: 1.8, display: "flex", gap: 6 }}>
                  <span style={{ fontFamily: "Oswald", color: C.warn }}>#{i + 1}</span>
                  <span>SET{allSets[t.si].setNo || t.si + 1}: {t.r.play}({labelOf(t.r.target)})</span>
                  <span style={{ marginLeft: "auto", fontFamily: "Oswald", color: t.r.wp > t.r.wpBefore ? C.us : C.them }}>
                    {Math.round(t.r.wpBefore * 100)}%→{Math.round(t.r.wp * 100)}%
                  </span>
                </div>
              ))}
            </>)}
          </div>

          {/* ★コート・ヒートマップ */}
          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 4 }}>🗺 失点ヒートマップ(どこからやられているか)</div>
            <CourtHeatmap />
            <div style={{ fontSize: 10, color: C.dim }}>円が大きく濃いほど失点が多い。次のセットのブロック・レシーブ配置の根拠に。</div>
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 8 }}>モメンタム(青実線)と勝率(黄点線)の推移</div>
            {allSets.length === 0 ? (
              <div style={{ fontSize: 12, color: C.dim }}>まだ記録がありません。</div>
            ) : allSets.map((s, i) => <SetChart key={i} s={s} label={`SET ${s.setNo || i + 1}`} />)}
            <div style={{ fontSize: 10, color: C.dim }}>🟡T = タイムアウト実施 / 🔴○ = 警告を無視した地点</div>
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>🔄 自チームのローテーション別 得失点</div>
            {rotStats.every(s => s.won + s.lost === 0) ? (
              <div style={{ fontSize: 12, color: C.dim }}>まだ記録がありません。</div>
            ) : (<>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
                {rotStats.map((s, i) => {
                  const total = s.won + s.lost;
                  const isWorst = worstRot && worstRot.i === i;
                  return (
                    <div key={i} style={{ background: "#0A0F1E", borderRadius: 10, padding: "8px 2px", textAlign: "center", border: isWorst ? `1px solid ${C.them}` : "1px solid transparent" }}>
                      <div style={{ fontSize: 10, fontWeight: 900, color: isWorst ? C.them : C.dim }}>R{i + 1}{isWorst && "⚠"}</div>
                      <div style={{ fontFamily: "Oswald", fontSize: 14 }}>
                        <span style={{ color: C.us }}>{s.won}</span><span style={{ color: C.dim, fontSize: 10 }}>-</span><span style={{ color: C.them }}>{s.lost}</span>
                      </div>
                      <div style={{ height: 4, borderRadius: 2, background: C.line, marginTop: 4, overflow: "hidden" }}>
                        {total > 0 && <div style={{ width: `${(s.won / total) * 100}%`, height: "100%", background: C.us }} />}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: C.dim, marginTop: 8 }}>
                R1=初期ローテ。{worstRot && <>⚠<b style={{ color: C.them }}>R{worstRot.i + 1}</b>が最も失点が込むローテです。試合中はこのローテ突入時に自動で警告が出ます。</>}
              </div>
            </>)}
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>🧍 選手単位の分析</div>
            {topLoss.length > 0 && (<>
              <div style={{ fontSize: 11, fontWeight: 900, color: C.them, marginBottom: 6 }}>⚠ 失点元ランキング</div>
              {topLoss.map(([k, v]) => {
                const t = keyToTarget(k);
                const max = topLoss[0][1];
                return (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 12 }}>
                    <span style={{ width: 110, fontWeight: 700, color: t.team === "us" ? C.us : C.them }}>{labelOf(t)}</span>
                    <div style={{ flex: 1, height: 10, background: "#0A0F1E", borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ width: `${(v / max) * 100}%`, height: "100%", background: t.team === "us" ? C.us : C.them, borderRadius: 5 }} />
                    </div>
                    <span style={{ fontFamily: "Oswald", width: 30, textAlign: "right" }}>{v}本</span>
                  </div>
                );
              })}
            </>)}
            {topWin.length > 0 && (<>
              <div style={{ fontSize: 11, fontWeight: 900, color: C.us, margin: "10px 0 6px" }}>🌟 得点源(エース)</div>
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                {topWin.map(([k, v]) => `${labelOf(keyToTarget(k))} ${v}点`).join(" / ")}
              </div>
            </>)}
            {topLoss.length === 0 && topWin.length === 0 && <div style={{ fontSize: 12, color: C.dim }}>まだ記録がありません。</div>}
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>🔬 AI判定の検証データ(自動収集)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, textAlign: "center" }}>
              <div style={{ background: "#0A0F1E", borderRadius: 14, padding: 12 }}>
                <div style={{ fontFamily: "Oswald", fontSize: 30, color: C.warn }}>{toRate !== null ? `${Math.round(toRate * 100)}%` : "—"}</div>
                <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>TO実施後の<br />直後3ラリー得点率</div>
              </div>
              <div style={{ background: "#0A0F1E", borderRadius: 14, padding: 12 }}>
                <div style={{ fontFamily: "Oswald", fontSize: 30, color: C.them }}>{igRate !== null ? `${Math.round(igRate * 100)}%` : "—"}</div>
                <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.5 }}>警告無視後の<br />直後3ラリー得点率</div>
              </div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, color: C.dim }}>
              AI判定回数: <b style={{ color: C.txt }}>{verdictsAll.length}</b>回(警告 {alertVerdicts.length} / 温存 {verdictsAll.length - alertVerdicts.length})
              {alertVerdicts.length > 0 && <> / 警告の妥当率: <b style={{ color: C.txt }}>{correctAlerts}/{alertVerdicts.length}</b></>}
            </div>
            {/* ★研究用エクスポート */}
            <button style={{ ...btn("#232d47", { fontSize: 13, padding: "12px 8px", marginTop: 10 }) }} onClick={exportData} disabled={allSets.length === 0}>
              💾 試合データをエクスポート(JSON / 研究・統計分析用)
            </button>
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>⚙️ チーム適応: W_t 補正の提案</div>
            {calib.length === 0 ? (
              <div style={{ fontSize: 12, color: C.dim }}>失点ラッシュに偏るプレー種類は検出されていません(データを蓄積してください)。</div>
            ) : calib.map((c, i) => (
              <div key={i} style={{ background: "#0A0F1E", borderRadius: 14, padding: 12, marginBottom: 8, fontSize: 13 }}>
                <div style={{ fontWeight: 800 }}>{c.play}: W = {c.current.toFixed(1)} → <span style={{ color: C.warn }}>{c.suggested.toFixed(1)}</span> に引き上げ推奨</div>
                <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{c.note} — このチームの連続失点の引き金になっています</div>
              </div>
            ))}
          </div>

          <div style={panel}>
            <div style={{ fontSize: 12, color: C.dim, fontWeight: 800, marginBottom: 10 }}>🎯 弱点パターン → 次回練習メニュー</div>
            {topLossPlay.length > 0 && (
              <div style={{ fontSize: 13, lineHeight: 1.8, marginBottom: 10 }}>
                失点内訳: {topLossPlay.map(([k, v]) => `${k} ${v}本`).join(" / ")}
              </div>
            )}
            {!menu ? (
              <button style={btn(`linear-gradient(160deg, ${C.us}, #2456c9)`, { fontSize: 15, padding: "14px 8px" })} onClick={genMenu} disabled={menuLoading}>
                {menuLoading ? "🤖 AIがメニュー作成中…" : "🤖 AIに練習メニューを作らせる"}
              </button>
            ) : menu.map((d, i) => (
              <div key={i} style={{ background: "#0A0F1E", borderRadius: 14, padding: 12, marginBottom: 8, fontSize: 13, animation: "slideUp .3s" }}>
                <div style={{ fontWeight: 800 }}>{i + 1}. {d.title} <span style={{ color: C.warn, fontFamily: "Oswald" }}>{d.mins}分</span></div>
                <div style={{ fontSize: 12, color: C.dim, marginTop: 4, lineHeight: 1.6 }}>{d.desc}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, color: C.ok, fontWeight: 800, textAlign: "center" }}>
            🧠 試合終了時のデータはAI学習センターに自動保存されています
          </div>
          <button style={btn("linear-gradient(160deg, #33405f, #232d47)", { fontSize: 15, padding: "14px 8px" })} onClick={goHome}>
            🏠 ホームに戻る(記録をリセットして次の試合へ)
          </button>
        </>)}

        {/* ===== セット終了画面 ===== */}
        {setEnd && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 55, display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
            background: setEnd.winner === "us" ? "rgba(13,30,60,.96)" : "rgba(40,14,16,.96)",
          }}>
            <div style={{ width: "100%", maxWidth: 400, textAlign: "center", animation: "zoomIn .4s cubic-bezier(.2,1.4,.3,1)" }}>
              <div style={{ fontSize: 56 }}>{setEnd.winner === "us" ? "🏆" : "😤"}</div>
              <div style={{ fontFamily: "Oswald", fontSize: 30, fontWeight: 700, letterSpacing: 2, color: setEnd.winner === "us" ? C.us : C.them }}>
                SET {setNo} {setEnd.winner === "us" ? "WON!" : "LOST"}
              </div>
              <div style={{ fontFamily: "Oswald", fontSize: 64, fontWeight: 700, margin: "4px 0" }}>
                <span style={{ color: C.us }}>{us}</span><span style={{ color: C.dim }}> - </span><span style={{ color: C.them }}>{them}</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.dim, marginBottom: 18 }}>
                {setEnd.winner === "us"
                  ? (us > setTarget ? "デュースを制した!この粘りが本物の力 💪" : "セット獲得!この流れを次に繋げよう")
                  : (them > setTarget ? "デュースの末に惜敗…次は取り切ろう" : "切り替えよう。データは次のセットの武器になる")}
                <br />
                <span style={{ fontFamily: "Oswald", fontSize: 13 }}>セットカウント {setsWon.us + (setEnd.winner === "us" ? 1 : 0)} - {setsWon.them + (setEnd.winner === "them" ? 1 : 0)}</span>
              </div>
              <button style={btn(`linear-gradient(160deg, ${C.us}, #2456c9)`, { fontSize: 19, fontWeight: 900, marginBottom: 10 })}
                onPointerDown={press} onPointerUp={release} onPointerLeave={release} onClick={nextSet}>
                ▶ 次のセットへ(ローテ設定 → SET {setNo + 1})
              </button>
              <button style={btn("linear-gradient(160deg, #33405f, #232d47)", { fontSize: 15, padding: "14px 8px", marginBottom: 10 })} onClick={finishMatch}>
                📊 試合終了 → 分析レポート
              </button>
              <button style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 12, fontWeight: 700 }} onClick={undoFromSetEnd}>
                ↩ 入力ミス?最後の1本を取り消す
              </button>
            </div>
          </div>
        )}

        {/* ===== アラート ===== */}
        {alert && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(10,15,30,.93)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 50 }}>
            <div style={{ width: "100%", maxWidth: 400, background: "#161E33", border: `2px solid ${C.them}`, borderRadius: 26, padding: 26, textAlign: "center", animation: "siren 1.1s infinite, slideUp .3s" }}>
              <div style={{ fontSize: 38, animation: "pulse 1s infinite" }}>🚨</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: C.them, marginTop: 4 }}>AIコーチ判定: 今がタイムアウトの取り時!</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 2, marginTop: 6 }}>
                {[1, 2, 3, 4, 5].map(i => <span key={i} style={{ fontSize: 16, opacity: i <= (alert.urgency || 3) ? 1 : .25 }}>⭐</span>)}
              </div>
              <div style={{ fontSize: 13, color: C.dim, marginTop: 6, fontWeight: 700 }}>理由: {alert.reason} {alert.offline && "(オフライン判定)"}</div>
              <div style={{ margin: "14px 0", padding: 16, background: "#0A0F1E", borderRadius: 16, fontSize: 15, lineHeight: 1.8, textAlign: "left" }}>📣 {alert.advice}</div>
              <button style={btn(C.warn, { color: "#1a1a1a", fontSize: 21, fontWeight: 900, boxShadow: `0 6px 24px ${C.warn}66` })} onPointerDown={press} onPointerUp={release} onPointerLeave={release} onClick={takeTimeout}>
                ⏱ タイムアウトを取る!(残{timeoutsLeft})
              </button>
              <button style={{ marginTop: 10, background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 13, fontWeight: 700 }} onClick={dismiss}>様子を見る(温存する)</button>
            </div>
          </div>
        )}

        {/* ===== タイムアウト30秒 ===== */}
        {timeout_ && (
          <div style={{ position: "fixed", inset: 0, zIndex: 60, textAlign: "center", padding: 28, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: `linear-gradient(180deg, ${C.warn}, #f0a818)`, color: "#1a1a1a" }}>
            <div style={{ fontWeight: 900, letterSpacing: 6, fontSize: 18 }}>TIMEOUT</div>
            <div style={{ position: "relative", width: 200, height: 200, margin: "12px 0" }}>
              <svg width="200" height="200" style={{ transform: "rotate(-90deg)" }}>
                <circle cx="100" cy="100" r={ringR} fill="none" stroke="rgba(0,0,0,.15)" strokeWidth="12" />
                <circle cx="100" cy="100" r={ringR} fill="none" stroke="#1a1a1a" strokeWidth="12" strokeLinecap="round" strokeDasharray={ringC} strokeDashoffset={ringC * (1 - timeout_.sec / 30)} style={{ transition: "stroke-dashoffset 1s linear" }} />
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Oswald", fontSize: 72, fontWeight: 700 }}>{timeout_.sec}</div>
            </div>
            <div style={{ background: "rgba(0,0,0,.14)", borderRadius: 18, padding: 20, fontSize: 18, fontWeight: 800, lineHeight: 1.9, maxWidth: 380 }}>📣 {timeout_.advice}</div>
            <button style={{ marginTop: 26, background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 16, padding: "14px 40px", fontSize: 16, fontWeight: 800, cursor: "pointer" }} onClick={() => setTimeoutS(null)}>試合に戻る →</button>
          </div>
        )}
      </div>
    </div>
  );
}
