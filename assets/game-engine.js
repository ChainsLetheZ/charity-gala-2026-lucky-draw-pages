const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const W = 1000;
const H = 700;
const LEFT = 35;
const RIGHT = 965;
// The Charity Gala machine's physical shelf sits lower than the earlier
// previous chamber layout. Keep the capsule bottoms on its white base rather
// than floating halfway up the red compartment.
const FLOOR = 690;
const DEPTH_LAYERS = 4;
const MAX_DEPTH = DEPTH_LAYERS - 1;
const DEPTH_SPACING = 74;
const DEPTH_PROJECTION = 30;
const CLAW_GRAB_OFFSET = 172;
// The PNG has transparent padding. Use a smaller physical radius than the visual draw radius.
const DRAW_RADIUS = 54;
const HIT_RADIUS = 49;

const params = new URLSearchParams(location.search);
const WS_URL = params.get('wsUrl') || 'wss://124.223.180.208/ws/charity-gala-2026';
let WS_TOKEN = new URLSearchParams(location.hash.slice(1)).get('token') || params.get('token') || sessionStorage.getItem('gala-sync-token') || '';
if (WS_TOKEN) sessionStorage.setItem('gala-sync-token', WS_TOKEN);
const operatorPage = Boolean(document.querySelector('#cursor'));
const PRIZES = [
  { id: 'first', tier: '一等奖', name: '博世手持电动料理棒', quantity: 15, image: 'assets/prizes/first-prize-blender.png', hue: 'hue-rotate(295deg) saturate(1.2)', ball: '#c22ac3' },
  { id: 'second', tier: '二等奖', name: '博世车载充电器 SC800', quantity: 20, image: 'assets/prizes/second-prize-sc800.png', hue: 'hue-rotate(215deg) saturate(1.2)', ball: '#187de0' },
  { id: 'third', tier: '三等奖', name: '博世车载充电器 SC580 + 博世数据线', quantity: 30, image: 'assets/prizes/third-prize-sc580-cable.png', hue: 'hue-rotate(165deg) saturate(1.15)', ball: '#009b89' }
];
// Warm all three images before the operator switches tiers on the projector.
const prizeImages = PRIZES.map(prize => {
  const image = new Image();
  image.src = prize.image;
  return image;
});
let currentPrizeId = localStorage.getItem('charity-gala-current-prize') || PRIZES[0].id;
if (!PRIZES.some(prize => prize.id === currentPrizeId)) currentPrizeId = PRIZES[0].id;
// Confirmed batch sizes from 抽奖名单 2.xlsx, sheet 抽奖批次.
const BATCH_PLAN = { first: [7, 8], second: [10, 10], third: [10, 10, 10] };
const redBall = new Image();
redBall.src = 'assets/charity-gala-ball-red-1254.png';
const whiteBall = new Image();
whiteBall.src = 'assets/charity-gala-ball-white-1254.png';
const clawImage = new Image();
clawImage.src = 'assets/charity-gala-supplier-day-claw.png?v=20261016-winners1';

function uniqueNames(list) {
  return Array.isArray(list)
    ? [...new Set(list.map(name => String(name).trim()).filter(Boolean))]
    : [];
}

const savedRoster = JSON.parse(localStorage.getItem('charity-gala-claw-roster') || 'null');
let people = [];
let winners = JSON.parse(localStorage.getItem('charity-gala-claw-winners') || '[]');
let winnerPrizeByName = JSON.parse(localStorage.getItem('charity-gala-winner-prizes') || '{}');
let participantMeta = JSON.parse(localStorage.getItem('charity-gala-claw-roster-meta') || '{}');
async function loadEventRoster() {
  if (!operatorPage) return;
  try {
    // The confirmed event roster is versioned alongside the operator page.
    const response = await fetch(new URL('../operator-data/roster.json', import.meta.url), { cache: 'no-store' });
    if (!response.ok) throw new Error('roster unavailable');
    const roster = await response.json();
    const names = uniqueNames(roster.people);
    if (!names.length || names.length !== roster.people.length) throw new Error('invalid roster');
    people = names;
    participantMeta = Object.fromEntries(names.map(name => [name, { name }]));
    localStorage.setItem('charity-gala-claw-roster', JSON.stringify(people));
    localStorage.setItem('charity-gala-claw-roster-meta', JSON.stringify(participantMeta));
  } catch {
    // A missing event file must never silently re-enable demo participants.
    people = uniqueNames(savedRoster).filter(name => !/^模拟嘉宾\s+\d+$/.test(name));
    showNotice(people.length ? `名单文件读取失败，使用本机已保存的 ${people.length} 人名单。` : '名单文件读取失败，请检查操作端 operator-data/roster.json。');
  }
}
let queue = [];
let cards = [];
let busy = false;
let armed = false;
let clock = 0;
let claw = { x: 500, y: 65, state: 'idle', card: null, timer: 0 };
let grabTarget = null;
let socket = null;
let wsReady = false;
let operatorReplaced = false;
let historySignature = null;
let winnerSignature = null;
let lastSync = 0;
let lastReceived = 0;
let activeWinner = null;
let armTime = 0;
let manualMode = false;
let manualLeft = false;
let manualRight = false;
let mouseDragging = false;
let manualVelocity = 0;
let stirTimer = 0;
let batchRemaining = 0;
let batchPrizeId = null;
let batchSelectedNames = [];
let grabTargets = [];
let grabOffsets = new Map();
let grabAnchorDepth = 0;
let grabSqueeze = 0;
let batchTimer = 0;
let prizeIntroTimer = 0;
const MANUAL_MOVE_SPEED = 7;
const MANUAL_MOVE_EASING = .2;
const STIR_DURATION = 120;

const esc = s => String(s).replace(/[&<>'"]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[c]));

function connect() {
  const syncStatus = document.querySelector('#syncStatus');
  const updateSyncStatus = (state, label) => {
    if (!syncStatus) return;
    syncStatus.dataset.state = state;
    const text = syncStatus.querySelector('span');
    if (text) text.textContent = label;
  };
  updateSyncStatus('connecting', '云端同步连接中');
  try {
    const endpoint = new URL(WS_URL);
    endpoint.searchParams.set('token', WS_TOKEN);
    endpoint.searchParams.set('role', operatorPage ? 'operator' : 'display');
    endpoint.searchParams.set('protocol', '2');
    socket = new WebSocket(endpoint);
  } catch {
    updateSyncStatus('offline', '同步服务不可用，正在重连');
    setTimeout(connect, 2000);
    return;
  }
  socket.onopen = () => {
    lastReceived = 0;
    wsReady = !operatorPage;
    updateSyncStatus('connected', operatorPage ? '云端中继已连接' : '同步已连接，等待画面');
  };
  socket.onclose = event => {
    wsReady = false;
    if (event.code === 4009) {
      operatorReplaced = true;
      armed = false;
      manualLeft = manualRight = mouseDragging = false;
      manualVelocity = 0;
      updateSyncStatus('offline', '已停用：另一个操作页正在控制');
      showNotice('另一个操作页已接管抽奖。请关闭这个旧操作页，使用最新打开的操作页。');
      return;
    }
    if (event.code === 4001) {
      wsReady = false;
      updateSyncStatus('offline', '同步口令不正确，请重新配置');
      return;
    }
    wsReady = false;
    updateSyncStatus('offline', '同步中断，正在重连');
    setTimeout(connect, 2000);
  };
  socket.onerror = () => updateSyncStatus('offline', '同步服务连接失败');
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'prize' && PRIZES.some(prize => prize.id === message.currentPrizeId)) {
      receivePrize(message.currentPrizeId, true);
      applyPrizePalette();
      renderHistory();
      return;
    }
    if (operatorPage) {
      if (message.type === 'state') {
        // Restore completed results when a different browser takes over.
        if (message.claw && Array.isArray(message.winners)) {
          const changed = JSON.stringify(winners) !== JSON.stringify(message.winners);
          winners = message.winners;
          winnerPrizeByName = message.winnerPrizeByName || {};
          participantMeta = message.participantMeta || participantMeta;
          // The local event file owns eligibility; a stale relay cannot replace it.
          receivePrize(message.currentPrizeId);
          localStorage.setItem('charity-gala-claw-winners', JSON.stringify(winners));
          localStorage.setItem('charity-gala-winner-prizes', JSON.stringify(winnerPrizeByName));
          localStorage.setItem('charity-gala-claw-roster-meta', JSON.stringify(participantMeta));
          localStorage.setItem('charity-gala-current-prize', currentPrizeId);
          if (changed) reset(false);
          renderHistory();
          if (message.activeWinner?.names) showWinners(message.activeWinner.names, message.activeWinner.participants);
          else if (message.activeWinner?.name) showWinner(message.activeWinner.name, message.activeWinner.participant);
          else closeWinner(false);
        }
        wsReady = true;
        send('roster', { people, winners, participantMeta, winnerPrizeByName, currentPrizeId, activeWinner });
        lastSync = -Infinity;
        sync();
      }
      return;
    }
    if (message.type === 'snapshot') lastReceived = performance.now();
    updateSyncStatus(
      'connected',
      message.type === 'snapshot' ? '显示端实时同步' : '服务已连接，等待画面'
    );
    if (message.type === 'state' || message.type === 'snapshot') {
      if (message.claw) claw = { ...message.claw, card: null };
      if (Array.isArray(message.cards)) {
        cards = message.cards.map(card => ({
          ...card,
          radius: HIT_RADIUS,
          vx: 0,
          vy: 0,
          spin: 0,
          sleep: true
        }));
      }
      if (Array.isArray(message.winners)) winners = message.winners;
      if (message.winnerPrizeByName) winnerPrizeByName = message.winnerPrizeByName;
      receivePrize(message.currentPrizeId);
      if (message.participantMeta) participantMeta = message.participantMeta;
      renderHistory();
      if ('activeWinner' in message) {
        if (Array.isArray(message.activeWinner?.names)) showWinners(message.activeWinner.names, message.activeWinner.participants);
        else if (message.activeWinner) showWinner(message.activeWinner.name, message.activeWinner.participant);
        else closeWinner(false);
      }
      if (message.closeWinner) closeWinner(false);
    } else if (message.type === 'winner' || message.type === 'winners' || message.type === 'roster') {
      if (Array.isArray(message.winners)) winners = message.winners;
      if (message.winnerPrizeByName) winnerPrizeByName = message.winnerPrizeByName;
      receivePrize(message.currentPrizeId);
      if (Array.isArray(message.people)) people = uniqueNames(message.people);
      if (message.participantMeta && typeof message.participantMeta === 'object') {
        participantMeta = message.participantMeta;
        localStorage.setItem('charity-gala-claw-roster-meta', JSON.stringify(participantMeta));
      }
      renderHistory();
      if (message.type === 'winner') {
        if (message.participant) participantMeta[message.name] = message.participant;
        showWinner(message.name, message.participant || participantMeta[message.name]);
      } else if (message.type === 'winners') {
        showWinners(message.names || [], message.participants || []);
      }
    }
  };
}

function send(type, data = {}) {
  if (wsReady && !operatorReplaced && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data }));
}

function sync() {
  if (!operatorPage) return;
  if (performance.now() - lastSync < 90) return;
  lastSync = performance.now();
  send('snapshot', {
    winners, participantMeta, winnerPrizeByName, currentPrizeId, activeWinner,
    claw,
    cards: cards.map(c => ({
      name: c.name, x: c.x, y: c.y, angle: c.angle,
      scale: c.scale, depth: c.depth, state: c.state, real: c.real, ball: c.ball
    })),
      remaining: queue.length + cards.filter(c => c.real).length
  });
}

function renderHistory() {
  const list = document.querySelector('#historyList');
  if (!list) return;
  const prize = currentPrize();
  const prizeWinners = winners.filter(name => winnerPrizeByName[name] === prize.id);
  const visibleWinners = prizeWinners.slice(-12);
  const signature = JSON.stringify([currentPrizeId, prizeWinners, participantMeta]);
  if (historySignature === signature) return;
  historySignature = signature;
  list.innerHTML = visibleWinners.length
    ? visibleWinners.map((name, i) => {
      const info = participantMeta[name] || { name };
      const ordinal = prizeWinners.indexOf(name) + 1;
      return `<div class="winner-card"><span class="winner-ordinal">${String(ordinal).padStart(2, '0')}</span><div class="winner-details"><b>${esc(info.nameZh || info.name || name)}</b>${info.nameEn ? `<div class="winner-name-en">${esc(info.nameEn)}</div>` : ''}${info.companyZh ? `<div class="winner-company-zh">${esc(info.companyZh)}</div>` : ''}${info.companyEn ? `<div class="winner-company-en">${esc(info.companyEn)}</div>` : ''}</div></div>`;
    }
    ).join('')
    : '<div class="empty">本轮中奖名单将从这里开始</div>';
  list.querySelectorAll('.winner-card').forEach(card => {
    card.style.minHeight = '30px';
    card.style.flexShrink = '0';
    card.style.padding = '3px 1px';
    card.style.gridTemplateColumns = '32px minmax(0, 1fr)';
  });
  const count = document.querySelector('#winnerCount');
  if (count) count.textContent = `${String(prizeWinners.length).padStart(2, '0')} / ${prize.quantity}`;
  const heading = document.querySelector('#historyTitle');
  if (heading) heading.textContent = `${prize.tier}中奖名单`;
  const listEnd = list.lastElementChild;
  if (listEnd) listEnd.scrollIntoView({ block: 'end' });
  renderPrizePanel();
}

function winnerCsv() {
  // Export every completed result in draw order, across all prize tiers.
  const rows = [['序号', '姓名', '奖项', '奖品'], ...winners.map((name, index) => {
    const prize = PRIZES.find(item => item.id === winnerPrizeByName[name]);
    const info = participantMeta[name] || {};
    return [index + 1, info.nameZh || info.name || name, prize?.tier || '待确认', prize?.name || ''];
  })];
  const cell = value => {
    let text = String(value);
    // Keep participant text as text when opened in a spreadsheet.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

function downloadWinners() {
  if (!operatorPage) return;
  if (!winners.length) {
    showNotice('暂无获奖记录，完成开奖后可下载获奖名单。');
    return;
  }
  const blob = new Blob([winnerCsv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  link.href = url;
  link.download = `慈善晚会2026-获奖名单-${stamp}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (operatorPage) document.querySelector('#downloadWinners')?.addEventListener('click', downloadWinners);

function currentPrize() { return PRIZES.find(prize => prize.id === currentPrizeId) || PRIZES[0]; }

function receivePrize(id, announce = false) {
  if (!PRIZES.some(prize => prize.id === id)) return;
  const changed = currentPrizeId !== id;
  currentPrizeId = id;
  localStorage.setItem('charity-gala-current-prize', id);
  // Snapshot/reconnect updates must also refresh an already visible intro.
  if (announce || (changed && !operatorPage)) showPrizeIntro();
}

function nextBatchSize(prizeId = currentPrizeId) {
  const plan = BATCH_PLAN[prizeId];
  const count = prizeWinnerCount(prizeId);
  let end = 0;
  for (const size of plan) {
    end += size;
    if (count < end) return end - count;
  }
  return 0;
}
let noticeTimer = 0;
function showNotice(message) {
  let notice = document.querySelector('#operatorNotice');
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'operatorNotice';
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'position:fixed;left:50%;bottom:7%;z-index:30;transform:translateX(-50%);max-width:min(90vw,720px);padding:14px 22px;border:1px solid #f1c875;border-radius:12px;background:#102f45ee;color:#fff;font:600 16px/1.5 Arial,"Microsoft YaHei",sans-serif;text-align:center;box-shadow:0 8px 32px #0005;opacity:0;transition:opacity .18s;pointer-events:none';
    document.body.append(notice);
  }
  notice.textContent = message;
  notice.style.opacity = '1';
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.style.opacity = '0'; }, 2800);
}

function prizeWinnerCount(prizeId = currentPrizeId) {
  return winners.filter(name => winnerPrizeByName[name] === prizeId).length;
}

function selectPrizeStep(step) {
  if (batchRemaining || busy) return;
  const index = PRIZES.findIndex(prize => prize.id === currentPrizeId);
  currentPrizeId = PRIZES[(index + step + PRIZES.length) % PRIZES.length].id;
  localStorage.setItem('charity-gala-current-prize', currentPrizeId);
  applyPrizePalette();
  renderHistory();
  showPrizeIntro();
  send('prize', { currentPrizeId });
}

function applyPrizePalette() {
  for (const card of cards) card.ball = Math.random() < .46 ? 'white' : 'red';
}

function showPrizeIntro() {
  let modal = document.querySelector('#prizeIntroModal');
  if (!modal) {
    modal = document.createElement('section');
    modal.id = 'prizeIntroModal';
    modal.className = 'prize-intro-modal';
    modal.setAttribute('role', 'status');
    modal.innerHTML = '<article><img id="introPrizeImage" alt=""><div><small>奖品揭晓</small><strong id="introPrizeTier"></strong><h2 id="introPrizeName"></h2><p>幸运好礼 · 敬请期待</p></div></article>';
    document.body.append(modal);
  }
  const prize = currentPrize();
  modal.style.setProperty('--prize-color', prize.ball);
  modal.querySelector('#introPrizeImage').src = prize.image;
  modal.querySelector('#introPrizeImage').alt = prize.name;
  modal.querySelector('#introPrizeTier').textContent = prize.tier;
  modal.querySelector('#introPrizeName').textContent = prize.name;
  modal.classList.add('show');
  clearTimeout(prizeIntroTimer);
  prizeIntroTimer = setTimeout(() => modal.classList.remove('show'), 6000);
}

function renderPrizePanel() {
  const stage = document.querySelector('.stage');
  if (!stage) return;
  let panel = document.querySelector('#prizePanel');
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'prizePanel';
    panel.className = 'prize-panel';
    panel.innerHTML = '<div class="prize-copy"><small class="prize-eyebrow">本轮好礼</small><strong id="prizeTier"></strong><b id="prizeName"></b></div><div class="prize-art"><img id="prizeImage" alt="当前奖品"></div>';
    (document.querySelector('.history') || stage).append(panel);
  }
  const prize = currentPrize();
  panel.dataset.prize = prize.id;
  panel.style.setProperty('--prize-color', prize.ball);
  panel.querySelector('#prizeTier').textContent = prize.tier;
  panel.querySelector('#prizeName').textContent = prize.name;
  panel.querySelector('#prizeImage').src = prize.image;
  panel.querySelector('#prizeImage').alt = prize.name;
}

function closeWinner(syncDisplay = false) {
  const modal = document.querySelector('#winnerModal');
  if (!modal?.classList.contains('show')) return;
  modal.classList.remove('show');
  activeWinner = null;
  winnerSignature = null;
  if (syncDisplay && operatorPage) {
    send('snapshot', {
      claw, winners, winnerPrizeByName, currentPrizeId, activeWinner, participantMeta,
      cards: cards.map(c => ({
        name: c.name, x: c.x, y: c.y, angle: c.angle,
        scale: c.scale, depth: c.depth, state: c.state, real: c.real, ball: c.ball
      })),
      remaining: queue.length + cards.filter(c => c.real).length,
      closeWinner: true
    });
  }
}

function showWinners(names, participants = []) {
  const modal = document.querySelector('#winnerModal');
  const safeNames = uniqueNames(names);
  if (!modal || !safeNames.length) return;
  const safeParticipants = safeNames.map((name, index) => participants[index] || participantMeta[name] || { name });
  const signature = JSON.stringify([currentPrizeId, safeNames, safeParticipants]);
  if (winnerSignature === signature && modal.classList.contains('show')) return;
  winnerSignature = signature;
  activeWinner = { names: safeNames, participants: safeParticipants };
  const tierLabel = document.querySelector('#winnerModal small');
  if (tierLabel) tierLabel.textContent = `${currentPrize().tier} · ${currentPrize().name}`;
  const winnerName = document.querySelector('#winnerName');
  if (winnerName) {
    winnerName.innerHTML = safeNames.map((name, index) => {
      const info = safeParticipants[index];
      return `<div style="padding:8px 0;font-size:${safeNames.length > 1 ? '.58em' : '1em'};line-height:1.2">${safeNames.length > 1 ? `${String(index + 1).padStart(2, '0')}　` : ''}${esc(info.nameZh || info.name || name)}${info.nameEn ? `<div style="font-size:.58em;margin-top:5px">${esc(info.nameEn)}</div>` : ''}</div>`;
    }).join('');
    winnerName.style.fontSize = 'clamp(34px, 5vw, 58px)';
    winnerName.style.margin = '14px 0';
  }
  const article = modal.querySelector('article');
  if (article) {
    article.style.width = 'min(820px, 90vw)';
    article.style.padding = '46px 60px';
    article.style.maxWidth = '90vw';
    article.style.maxHeight = '90vh';
    article.style.overflowY = 'auto';
    article.style.overflowWrap = 'anywhere';
    let company = article.querySelector('#winnerCompany');
    if (!company) {
      company = document.createElement('div');
      company.id = 'winnerCompany';
      article.insertBefore(company, winnerName || article.firstChild);
    }
    const info = safeParticipants[0];
    company.innerHTML = `<div>${esc(info.companyZh || '')}</div><div>${esc(info.companyEn || '')}</div>`;
    company.style.cssText = 'margin:20px 0 0;color:#f1c875;font-size:clamp(22px,2.4vw,35px);font-weight:600;line-height:1.45;text-shadow:0 2px 8px #000';
    company.style.display = safeNames.length === 1 && (info.companyZh || info.companyEn) ? 'block' : 'none';
  }
  modal.classList.add('show');
}

function showWinner(name, participant = participantMeta[name]) {
  showWinners([name], [participant || { name }]);
}

function setManualMode(enabled) {
  if (!operatorPage) return;
  manualMode = enabled;
  armed = false;
  manualLeft = false;
  manualRight = false;
  mouseDragging = false;
  manualVelocity = 0;
  const toggle = ensureManualToggle();
  if (toggle) {
    toggle.textContent = manualMode ? '手动备份 ON' : '手势控制';
    toggle.setAttribute('aria-pressed', String(manualMode));
  }
  const cursor = document.querySelector('#cursor');
  if (cursor) cursor.style.display = manualMode ? 'none' : 'block';
  if (canvas) canvas.style.cursor = manualMode ? 'grab' : '';
}

function ensureManualToggle() {
  if (!operatorPage) return null;
  let toggle = document.querySelector('#manualToggle');
  if (toggle) return toggle;
  toggle = document.createElement('button');
  toggle.id = 'manualToggle';
  toggle.type = 'button';
  toggle.textContent = '手势控制';
  toggle.setAttribute('aria-pressed', 'false');
  toggle.style.display = 'none';
  toggle.addEventListener('click', () => setManualMode(!manualMode));
  document.body.appendChild(toggle);
  return toggle;
}

function makeCard(name, x, y, real = true, depth = 0, ball = 'red') {
  return {
    name, x, y,
    vx: (Math.random() - .5) * 1.1,
    vy: Math.random() * 1.2,
    vz: (Math.random() - .5) * .18,
    // Start level; movement and collisions create the tilt dynamically.
    angle: 0,
    spin: 0,
    scale: 1,
    state: 'floor', real, depth, radius: HIT_RADIUS, ball
  };
}

function reset(clear = true) {
  if (clear) {
    winners = [];
    winnerPrizeByName = {};
    currentPrizeId = PRIZES[0].id;
    localStorage.setItem('charity-gala-claw-winners', '[]');
    localStorage.setItem('charity-gala-winner-prizes', '{}');
    localStorage.setItem('charity-gala-current-prize', currentPrizeId);
    batchRemaining = 0;
    batchPrizeId = null;
    clearTimeout(batchTimer);
  }
  queue = [...people.filter(n => !winners.includes(n))].sort(() => Math.random() - .5);
  cards = [];
  grabTargets = [];
  const visibleCount = 65;
  // Keep the chamber visually full even after previous winners have been removed.
  // Filler capsules are decorative only and are never valid grab targets.
  const visible = [...queue];
  while (visible.length < visibleCount) visible.push(null);
  for (let i = 0; i < Math.min(visibleCount, visible.length); i++) {
    const depth = Math.max(0, Math.min(MAX_DEPTH, i % DEPTH_LAYERS + (Math.random() - .5) * .3));
    const spread = RIGHT - LEFT - DRAW_RADIUS * 2;
    const real = visible[i] !== null;
    cards.push(makeCard(
      real ? queue.shift() : `visual-capsule-${i}`,
      LEFT + DRAW_RADIUS + Math.random() * spread,
      FLOOR - DRAW_RADIUS * .95 - Math.random() * 190,
      real, depth, Math.random() < .46 ? 'white' : 'red'
    ));
  }
  grabOffsets = new Map();
  grabSqueeze = 0;
  claw = { x: 500, y: 65, state: 'idle', card: null, timer: 0 };
  grabTarget = null;
  stirTimer = 0;
  busy = false;
  armed = false;
  armTime = 0;
  renderHistory();
  if (operatorPage) {
    send('roster', { people, winners, participantMeta, winnerPrizeByName, currentPrizeId });
    sync();
  }
}

function drawCapsule(c) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(LEFT, 0, RIGHT - LEFT, FLOOR);
  ctx.clip();
  ctx.translate(c.x, c.y - c.depth * DEPTH_PROJECTION);
  ctx.rotate(c.angle);
  // Keep the source artwork proportional; the machine window itself is wider.
  ctx.scale(c.scale, c.scale);
  ctx.shadowColor = '#000b';
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 12;
  const ball = c.ball === 'white' ? whiteBall : redBall;
  ctx.filter = 'none';
  if (ball.complete && ball.naturalWidth) {
    ctx.drawImage(ball, -DRAW_RADIUS, -DRAW_RADIUS, DRAW_RADIUS * 2, DRAW_RADIUS * 2);
  } else {
    ctx.fillStyle = c.ball === 'white' ? '#f5f5f5' : '#e43142';
    ctx.beginPath();
    ctx.arc(0, 0, DRAW_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'none';
  ctx.restore();
}


function drawClaw() {
  ctx.save();
  ctx.strokeStyle = '#d7e8f2';
  ctx.lineWidth = 7;
  ctx.shadowColor = '#61cfff';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(claw.x, 0);
  ctx.lineTo(claw.x, Math.max(0, claw.y - 12));
  ctx.stroke();
  ctx.shadowBlur = 0;
  if (clawImage.complete && clawImage.naturalWidth) {
    // The operator's machine canvas is mirrored for hand control. Mirror the
    // claw sprite on the display page only so its claw artwork matches while
    // the display's capsule layout and the rest of the scene stay unchanged.
    if (!operatorPage) {
      ctx.translate(claw.x, 0);
      ctx.scale(-1, 1);
      ctx.translate(-claw.x, 0);
    }
    ctx.drawImage(clawImage, 0, 120, 1024, 1416, claw.x - 85, claw.y - 34, 170, 224);
  }
  ctx.restore();
}

function collide(a, b) {
  if (a.state === 'held' || b.state === 'held') return;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = (b.depth - a.depth) * DEPTH_SPACING;
  const dist = Math.hypot(dx, dy, dz);
  const min = a.radius * a.scale + b.radius * b.scale;
  // Small dead-band prevents floor contacts from oscillating forever.
  if (dist >= min - .5) return;
  const nx = dist < .001 ? 0 : dx / dist;
  const ny = dist < .001 ? 0 : dy / dist;
  const nz = dist < .001 ? 1 : dz / dist;
  const overlap = min - dist;
  const total = a.radius * a.scale + b.radius * b.scale;
  const moveA = b.radius * b.scale / total;
  const moveB = a.radius * a.scale / total;
  a.x -= nx * overlap * moveA;
  a.y -= ny * overlap * moveA;
  a.depth -= nz * overlap * moveA / DEPTH_SPACING;
  b.x += nx * overlap * moveB;
  b.y += ny * overlap * moveB;
  b.depth += nz * overlap * moveB / DEPTH_SPACING;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny +
    (b.vz - a.vz) * DEPTH_SPACING * nz;
  if (rel < 0) {
    const impulse = -rel * .12;
    a.vx -= nx * impulse;
    b.vx += nx * impulse;
    a.vy -= ny * impulse;
    b.vy += ny * impulse;
    a.vz -= nz * impulse / DEPTH_SPACING;
    b.vz += nz * impulse / DEPTH_SPACING;
  }
  // Tangential contact creates tilt only while objects are moving.
  const torque = ((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) * .012;
  a.spin -= torque;
  b.spin += torque;
  a.spin *= .985;
  b.spin *= .985;
}

function supportedByPile(c) {
  const r = c.radius * c.scale;
  if (c.y >= FLOOR - DRAW_RADIUS * c.scale - .5) return true;
  return cards.some(other => {
    if (other === c || other.state === 'held' || other.y <= c.y) return false;
    const otherR = other.radius * other.scale;
    const verticalGap = other.y - c.y;
    const horizontalDepthDistance = Math.hypot(other.x - c.x, (other.depth - c.depth) * DEPTH_SPACING);
    const contactRadius = r + otherR + 5;
    return verticalGap <= contactRadius && horizontalDepthDistance <=
      Math.sqrt(Math.max(0, contactRadius ** 2 - verticalGap ** 2));
  });
}

// Use the artwork radius at the walls; the smaller hit radius is only for
// capsule-to-capsule contacts. Reapply after collision resolution, even asleep.
function constrainCard(c) {
  const r = DRAW_RADIUS * c.scale;
  if (c.x < LEFT + r) { c.x = LEFT + r; c.vx = Math.abs(c.vx) * .22; }
  if (c.x > RIGHT - r) { c.x = RIGHT - r; c.vx = -Math.abs(c.vx) * .22; }
  if (c.y < r) { c.y = r; c.vy = Math.max(0, c.vy); }
  if (c.y > FLOOR - r) {
    c.y = FLOOR - r;
    c.vy = 0;
    c.vx *= .9;
    if (Math.abs(c.vx) < .04) c.vx = 0;
  }
  if (c.depth < 0) { c.depth = 0; c.vz = Math.abs(c.vz) * .2; }
  if (c.depth > MAX_DEPTH) { c.depth = MAX_DEPTH; c.vz = -Math.abs(c.vz) * .2; }
}

function screenY(c) { return c.y - c.depth * DEPTH_PROJECTION; }

function captureCapsuleCluster(anchor) {
  const distance = card => Math.hypot(
    card.x - anchor.x,
    card.y - anchor.y,
    (card.depth - anchor.depth) * DEPTH_SPACING
  );
  const cluster = cards
    .filter(card => card.real && card.state === 'floor')
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, batchRemaining);
  if (!cluster.includes(anchor) && cluster.length) cluster[cluster.length - 1] = anchor;
  grabAnchorDepth = anchor.depth;
  grabOffsets = new Map(cluster.map(card => [card, {
    name: card.name,
    x: card.x - anchor.x,
    y: screenY(card) - screenY(anchor),
    depth: card.depth - anchor.depth,
    targetX: Math.max(-28, Math.min(28, (card.x - anchor.x) * .3 + (Math.random() - .5) * 8)),
    targetY: Math.max(-28, Math.min(35, (screenY(card) - screenY(anchor)) * .3 + (Math.random() - .5) * 8)),
    targetDepth: (card.depth - anchor.depth) * .35
  }]));
  grabSqueeze = 0;
  return cluster;
}

function physics() {
  for (const c of cards) {
    if (c.sleep && !supportedByPile(c)) c.sleep = false;
    if (c.state === 'held' || c.sleep) continue;
    c.vy += .42;
    c.x += c.vx;
    c.y += c.vy;
    c.depth += c.vz;
    c.spin += c.vx * .006;
    c.angle += c.spin;
    c.spin = Math.max(-.06, Math.min(.06, c.spin));
    c.angle = Math.max(-.78, Math.min(.78, c.angle));
    c.vx *= .992;
    c.vz *= .992;
    c.spin *= .986;
    constrainCard(c);
  }
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) collide(cards[i], cards[j]);
  }
  for (const c of cards) {
    constrainCard(c);
    const r = c.radius * c.scale;
    if (c.state !== 'held' && supportedByPile(c) && Math.abs(c.vy) < .08 && Math.abs(c.vx) < .04 && Math.abs(c.vz) < .015) {
      if (c.y > FLOOR - DRAW_RADIUS * c.scale) c.y = FLOOR - DRAW_RADIUS * c.scale;
      c.vy = 0;
      c.vx = 0;
      c.vz = 0;
      c.sleep = true;
    }
  }
}

function target() {
  // Use the closest visible capsule only as the physical animation target.
  // The winner itself is selected independently from the full remaining roster.
  return cards.filter(c => c.real && c.state === 'floor' && screenY(c) >= DRAW_RADIUS && screenY(c) <= FLOOR)
    .sort((a, b) => a.depth - b.depth || Math.abs(a.x - claw.x) - Math.abs(b.x - claw.x))[0];
}

function randomPrizeTarget(preferredName = null) {
  const physicalTarget = target();
  const availableNames = people.filter(name => !winners.includes(name));
  if (!physicalTarget || !availableNames.length) return null;

  const chosenName = preferredName && availableNames.includes(preferredName)
    ? preferredName
    : availableNames[Math.floor(Math.random() * availableNames.length)];
  const chosenCard = cards.find(c => c.real && c.state === 'floor' && c.name === chosenName);

  if (chosenCard && chosenCard !== physicalTarget) {
    // Swap labels when the randomly chosen person is already visible.
    [physicalTarget.name, chosenCard.name] = [chosenCard.name, physicalTarget.name];
  } else if (!chosenCard) {
    // If the person is still in the hidden queue, move that name onto the
    // physical target and put the displaced name back into the queue.
    const queueIndex = queue.indexOf(chosenName);
    if (queueIndex >= 0) queue.splice(queueIndex, 1);
    const displacedName = physicalTarget.name;
    physicalTarget.name = chosenName;
    if (displacedName && displacedName !== chosenName && !queue.includes(displacedName)) {
      queue.push(displacedName);
    }
  }
  return physicalTarget;
}

function moveManualClaw(delta) {
  if (!operatorPage || operatorReplaced || !manualMode || busy || claw.state !== 'idle') return;
  claw.x = Math.max(LEFT + 30, Math.min(RIGHT - 30, claw.x + delta));
}

function moveManualClawToPointer(event) {
  if (!operatorPage || operatorReplaced || !manualMode || busy || claw.state !== 'idle') return;
  const rect = canvas.getBoundingClientRect();
  const x = (1 - (event.clientX - rect.left) / rect.width) * W;
  claw.x = Math.max(LEFT + 30, Math.min(RIGHT - 30, x));
}

function updateManualMovement() {
  if (!manualMode) {
    manualVelocity = 0;
    return;
  }
  const direction = (manualRight ? 1 : 0) - (manualLeft ? 1 : 0);
  const desiredVelocity = (!busy && claw.state === 'idle')
    ? -direction * MANUAL_MOVE_SPEED
    : 0;
  manualVelocity += (desiredVelocity - manualVelocity) * MANUAL_MOVE_EASING;
  if (Math.abs(manualVelocity) < .05) manualVelocity = 0;
  if (manualVelocity) moveManualClaw(manualVelocity);
}

function startDraw() {
  if (!operatorPage || operatorReplaced || busy || claw.state !== 'idle' || prizeWinnerCount(currentPrizeId) >= currentPrize().quantity) return false;
  // Choose one person randomly from the complete remaining roster, then lock
  // the nearest visible capsule for the physical grab animation.
  grabTarget = randomPrizeTarget(batchSelectedNames[0] || null);
  if (!grabTarget) return false;
  grabTargets = [grabTarget];
  armed = false;
  busy = true;
  claw.state = 'dropping';
  return true;
}

function startBatchDraw() {
  if (!operatorPage || operatorReplaced || batchRemaining || busy || claw.state !== 'idle') return;
  const prize = currentPrize();
  const slots = prize.quantity - prizeWinnerCount(prize.id);
  const size = nextBatchSize(prize.id);
  const availableNames = people.filter(name => !winners.includes(name));
  const available = availableNames.length;
  if (!people.length) {
    showNotice('当前没有可抽取名单，请先配置参与者数据。');
    return;
  }
  if (!size || slots < size || available < size) {
    showNotice(!size ? '本奖项已抽完，请切换奖项。' : `这一批需要 ${size} 位未中奖参与者；当前可抽 ${available} 位。`);
    return;
  }
  const pool = [...availableNames];
  batchSelectedNames = [];
  while (batchSelectedNames.length < size) {
    const pick = Math.floor(Math.random() * pool.length);
    batchSelectedNames.push(pool.splice(pick, 1)[0]);
  }
  batchRemaining = size;
  batchPrizeId = prize.id;
  renderPrizePanel();
  if (!startDraw()) {
    batchRemaining = 0;
    batchPrizeId = null;
    batchSelectedNames = [];
    renderPrizePanel();
    showNotice('抓取没有启动，请再按一次空格。');
  }
}

function winnerBatch(names) {
  const selected = uniqueNames(names).filter(name => !winners.includes(name));
  if (!batchRemaining || selected.length !== batchRemaining) return;
  winners.push(...selected);
  for (const name of selected) winnerPrizeByName[name] = batchPrizeId || currentPrizeId;
  localStorage.setItem('charity-gala-claw-winners', JSON.stringify(winners));
  localStorage.setItem('charity-gala-winner-prizes', JSON.stringify(winnerPrizeByName));
  renderHistory();
  const participants = selected.map(name => participantMeta[name] || { name });
  send('winners', { names: selected, participants, winners, winnerPrizeByName, currentPrizeId });
  showWinners(selected, participants);
  const selectedSet = new Set(selected);
  const grabbedSet = new Set(grabTargets);
  for (const card of grabTargets) {
    const originalName = grabOffsets.get(card)?.name || card.name;
    if (originalName && !selectedSet.has(originalName) && !queue.includes(originalName)) queue.push(originalName);
  }
  queue = queue.filter(name => !selectedSet.has(name));
  cards = cards.filter(card => !selectedSet.has(card.name) && !grabbedSet.has(card));
  while (cards.length < 65) addReplacementCard();
  batchRemaining = 0;
  batchPrizeId = null;
  batchSelectedNames = [];
  renderPrizePanel();
}

function stirCards() {
  for (const card of cards) {
    if (card.state !== 'floor' || card.y < DRAW_RADIUS) continue;
    card.sleep = false;
    card.vx += (Math.random() - .5) * 1.8;
    card.vy -= 1.8 + Math.random() * 1.8;
    card.vz += (Math.random() - .5) * .045;
    card.spin += (Math.random() - .5) * .025;
  }
}

function addReplacementCard() {
  const real = queue.length > 0;
  const name = real ? queue.shift() : `visual-capsule-${clock}-${cards.length}`;
  const depth = Math.random() * MAX_DEPTH;
  cards.push(makeCard(
    name,
    LEFT + DRAW_RADIUS + Math.random() * (RIGHT - LEFT - DRAW_RADIUS * 2),
    FLOOR - DRAW_RADIUS - 130,
    real,
    depth,
    Math.random() < .46 ? 'white' : 'red'
  ));
}

function step() {
  clock++;
  ctx.clearRect(0, 0, W, H);
  if (!operatorPage || operatorReplaced) {
    cards.sort((a, b) => (b.depth - a.depth) || (a.y - b.y)).forEach(drawCapsule);
    drawClaw();
    requestAnimationFrame(step);
    return;
  }
  if (stirTimer > 0) {
    stirTimer--;
    if (clock % 12 === 0) stirCards();
  }
  updateManualMovement();
  if (claw.state === 'dropping') {
    claw.y += 14;
    const t = grabTarget;
    if (t && t.real && t.state === 'floor' && screenY(t) >= DRAW_RADIUS && screenY(t) <= FLOOR &&
      claw.y + CLAW_GRAB_OFFSET >= screenY(t) - t.radius * t.scale) {
      claw.y = screenY(t) - CLAW_GRAB_OFFSET;
      claw.card = t;
      grabTargets = captureCapsuleCluster(t);
      claw.state = 'catch';
      claw.timer = 16;
    } else if (claw.y > FLOOR - CLAW_GRAB_OFFSET) {
      claw.y = FLOOR - CLAW_GRAB_OFFSET;
      claw.state = 'return';
    }
  } else if (claw.state === 'catch') {
    if (--claw.timer === 7 && batchRemaining && grabTargets.length === batchRemaining) {
      for (const card of grabTargets) card.state = 'held';
    }
    if (claw.timer <= 0) claw.state = 'return';
  } else if (claw.state === 'return') {
    claw.y -= 14;
    if (claw.y <= 65) { claw.y = 65; claw.state = 'home'; }
  } else if (claw.state === 'home') {
    claw.x += (500 - claw.x) * .24;
    if (Math.abs(claw.x - 500) < 3) {
      if (batchRemaining && grabTargets.length === batchRemaining) {
        const selected = [...batchSelectedNames];
        winnerBatch(selected);
        stirCards();
        stirTimer = STIR_DURATION;
      } else if (batchRemaining) {
        batchRemaining = 0;
        batchPrizeId = null;
        batchSelectedNames = [];
        showNotice('钩爪未抓齐本批胶囊，本次未抽取；请再按空格重试。');
      }
      claw = { x: 500, y: 65, state: 'idle', card: null, timer: 0 };
      grabTarget = null;
      grabTargets = [];
      busy = false;
    }
  }
  if (grabTargets.some(card => card.state === 'held')) {
    grabSqueeze = Math.min(1, grabSqueeze + .10);
  }
  for (const c of cards) {
    if (c.state === 'held') {
      const oldX = c.x;
      const offset = grabOffsets.get(c) || { x: 0, y: 0, depth: 0, targetX: 0, targetY: 0, targetDepth: 0 };
      const x = offset.x + (offset.targetX - offset.x) * grabSqueeze;
      const y = offset.y + (offset.targetY - offset.y) * grabSqueeze;
      const depth = offset.depth + (offset.targetDepth - offset.depth) * grabSqueeze;
      const heldScreenY = claw.y + CLAW_GRAB_OFFSET - 42 + y;
      c.x = claw.x + x;
      c.depth = Math.max(0, Math.min(MAX_DEPTH, grabAnchorDepth + depth));
      c.y = heldScreenY + c.depth * DEPTH_PROJECTION;
      c.angle += (c.x - oldX) * .012;
      c.spin += (c.x - oldX) * .001;
      c.vx = 0;
      c.vy = 0;
    } else if (c.state === 'fall') {
      c.vy += .45;
      c.y += c.vy;
      c.spin += c.vx * .006;
      c.angle += c.spin;
    }
  }
  if (clock % 2 === 0) physics();
  cards.forEach(constrainCard);
  cards.sort((a, b) => (b.depth - a.depth) || (a.y - b.y)).forEach(drawCapsule);
  drawClaw();
  sync();
  requestAnimationFrame(step);
}

function setCursor(x, y) {
  const cursor = document.querySelector('#cursor');
  if (!cursor || manualMode) return;
  cursor.style.display = 'block';
  const stageRect = document.querySelector('.stage').getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  cursor.style.left = `${canvasRect.left - stageRect.left + (1 - x) * canvasRect.width}px`;
  cursor.style.top = `${canvasRect.top - stageRect.top + y * canvasRect.height}px`;
}

let cameraStarting = false;
let handRecognizerReady = false;
async function startCamera() {
  if (cameraStarting) return;
  if (!window.isSecureContext) {
    showNotice('浏览器未将此页面识别为安全连接，无法启用摄像头；请通过 HTTPS 打开展示端。空格仍可直接抓取。');
    console.warn('[claw] camera requires HTTPS; open https://127.0.0.1:3002/ instead of file://');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showNotice('此浏览器无法访问摄像头；请使用 HTTPS 并检查浏览器设置。空格仍可直接抓取。');
    console.warn('[claw] this browser does not expose getUserMedia');
    return;
  }
  cameraStarting = true;
  showNotice('正在启动手势识别，请允许浏览器使用摄像头。');
  try {
    const video = document.querySelector('#camera');
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 10, max: 12 },
        facingMode: 'user'
      },
      audio: false
    });
    await video.play();
    video.classList.add('is-active');
    showNotice('摄像头已连接，正在加载手势识别。');
    const vision = await import('./mediapipe/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks(
      new URL('./mediapipe/wasm', import.meta.url).href
    );
    const hand = await vision.HandLandmarker.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: new URL('./mediapipe/models/hand_landmarker.task', import.meta.url).href,
        delegate: 'CPU'
      },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: .42,
      minHandPresenceConfidence: .42,
      minTrackingConfidence: .42
    });
    handRecognizerReady = true;
    showNotice('摄像头与手势识别已就绪：按 H 解锁一次下挥抓取；空格键直接抓取。');
    let smooth = null;
    let trail = [];
    let wasArmed = false;
    let cooldown = 0;
    let lastDetect = 0;
    const detect = now => {
      if (manualMode || operatorReplaced) {
        requestAnimationFrame(detect);
        return;
      }
      if (armed && !wasArmed) trail = [];
      wasArmed = armed;
      if (now - lastDetect > 90 && video.readyState >= 2) {
        lastDetect = now;
        const p = hand.detectForVideo(video, now).landmarks?.[0]?.[9];
        if (p) {
          smooth = smooth
            ? { x: smooth.x * .78 + p.x * .22, y: smooth.y * .78 + p.y * .22 }
            : { x: p.x, y: p.y };
          const x = 1 - smooth.x;
          setCursor(x, smooth.y);
          if (claw.state === 'idle') {
            claw.x = Math.max(LEFT + 30, Math.min(RIGHT - 30, x * W));
          }
          trail.push({ t: now, y: smooth.y });
          trail = trail.filter(item => item.t >= now - 450 && item.t >= armTime);
          if (armed && trail.length > 1 && now > cooldown) {
            const travel = smooth.y - trail[0].y;
            const span = now - trail[0].t;
            // A deliberate downward movement over a short trajectory, not a single noisy frame.
            if (span >= 120 && travel > .022) {
              cooldown = now + 1000;
              trail = [];
              startBatchDraw();
            }
          }
        }
      }
      requestAnimationFrame(detect);
    };
    requestAnimationFrame(detect);
  } catch (error) {
    cameraStarting = false;
    handRecognizerReady = false;
    document.querySelector('#camera')?.classList.remove('is-active');
    setManualMode(true);
    const detail = error?.name === 'NotAllowedError'
      ? '请在浏览器设置中允许摄像头，然后刷新操作页。'
      : error?.name === 'NotFoundError'
        ? '未检测到可用摄像头。'
        : '请检查摄像头权限和本地识别文件，然后刷新操作页。';
    showNotice(`摄像头或手势识别未能启动：${detail}空格仍可直接抓取。`);
    console.warn('[claw] camera/hand recognition unavailable:', error);
  }
}

document.querySelector('#closeWinner')?.remove();

addEventListener('keydown', e => {
  if (operatorReplaced) return;
  if (e.target?.matches?.('input,textarea,select,button,a[href],[contenteditable="true"]')) return;
  if (e.code === 'KeyM') {
    if (!operatorPage) return;
    if (e.repeat) return;
    e.preventDefault();
    setManualMode(!manualMode);
  } else if (manualMode && e.code === 'KeyA') {
    e.preventDefault();
    manualLeft = true;
  } else if (manualMode && e.code === 'KeyD') {
    e.preventDefault();
    manualRight = true;
  } else if (operatorPage && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    if (e.repeat) return;
    e.preventDefault();
    selectPrizeStep(e.code === 'ArrowLeft' ? -1 : 1);
  } else if (e.code === 'KeyH') {
    if (!operatorPage) return;
    if (e.repeat) return;
    e.preventDefault();
    if (busy || batchRemaining) {
      showNotice('当前抓取尚未结束，结束后再按 H 解锁下一次手势抓取。');
      return;
    }
    if (!handRecognizerReady) {
      showNotice('摄像头识别尚未就绪；请先等待摄像头与识别就绪提示。');
      return;
    }
    if (manualMode) setManualMode(false);
    armed = true;
    armTime = performance.now();
    showNotice(`已解锁一次手势抓取：向下挥手抓取本批 ${nextBatchSize()} 颗胶囊；完成后自动锁定，再按 H 抓下一批。`);
  } else if (e.code === 'Space' || e.code === 'Enter') {
    if (!operatorPage) return;
    e.preventDefault();
    startBatchDraw();
  } else if (e.code === 'KeyR') {
    if (!operatorPage || e.repeat) return;
    e.preventDefault();
    // Local confirmation only; the display receives the reset state after approval.
    if (!window.confirm('确定重置抽奖吗？这将清空所有中奖记录，并开始新一轮抽奖。')) return;
    reset(true);
  } else if (e.code === 'Escape') {
    if (!operatorPage) return;
    e.preventDefault();
    closeWinner(true);
  }
}, { capture: true });

addEventListener('keyup', e => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') manualLeft = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') manualRight = false;
});

canvas?.addEventListener('pointerdown', e => {
  if (!operatorPage || !manualMode || e.pointerType !== 'mouse' || e.button !== 0) return;
  if (busy || claw.state !== 'idle') return;
  mouseDragging = true;
  canvas.setPointerCapture?.(e.pointerId);
  canvas.style.cursor = 'grabbing';
  e.preventDefault();
  moveManualClawToPointer(e);
});

canvas?.addEventListener('pointermove', e => {
  if (!mouseDragging || e.pointerType !== 'mouse') return;
  e.preventDefault();
  moveManualClawToPointer(e);
});

const stopMouseDrag = e => {
  if (e?.pointerType && e.pointerType !== 'mouse') return;
  mouseDragging = false;
  if (manualMode && canvas) canvas.style.cursor = 'grab';
};
canvas?.addEventListener('pointerup', stopMouseDrag);
canvas?.addEventListener('pointercancel', stopMouseDrag);
canvas?.addEventListener('lostpointercapture', stopMouseDrag);

const machinePanel = document.querySelector('.machine');
const credit = document.querySelector('.uxgs-credit');
const historyPanel = document.querySelector('.history');
if (historyPanel) {
  // These coordinates are measured from the approved Charity Gala artwork:
  // the canvas fills the left machine chamber and the winner list fills the
  // blank frame in the right display column. Compute from the rendered image
  // rather than viewport percentages so crop/letterbox changes stay aligned.
  const charityLayout = {
    machine: { left: 0.11, top: 0.21, width: 0.55, height: 0.61 },
    history: { left: 0.70, top: 0.14, width: 0.17, height: 0.48 },
  };
  const stage = document.querySelector('.stage');
  const background = document.querySelector('.motion-bg');
  const alignOverlaysToVideo = () => {
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    const videoWidth = background.videoWidth || background.naturalWidth || 1672;
    const videoHeight = background.videoHeight || background.naturalHeight || 942;
    const scale = Math.max(width / videoWidth, height / videoHeight);
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const offsetX = (width - renderedWidth) / 2;
    const offsetY = (height - renderedHeight) / 2;
    historyPanel.style.left = `${offsetX + renderedWidth * charityLayout.history.left}px`;
    historyPanel.style.top = `${offsetY + renderedHeight * charityLayout.history.top}px`;
    historyPanel.style.width = `${renderedWidth * charityLayout.history.width}px`;
    historyPanel.style.height = `${renderedHeight * charityLayout.history.height}px`;
    if (credit) {
      credit.style.left = `${offsetX + renderedWidth * 0.38}px`;
      credit.style.top = `${offsetY + renderedHeight * 0.90}px`;
      // 216px at the 1920px reference width, scaled with the video.
      credit.style.width = `${renderedWidth * (216 / 1920)}px`;
    }
    if (machinePanel) {
      machinePanel.style.left = `${offsetX + renderedWidth * charityLayout.machine.left}px`;
      machinePanel.style.top = `${offsetY + renderedHeight * charityLayout.machine.top}px`;
      machinePanel.style.width = `${renderedWidth * charityLayout.machine.width}px`;
      machinePanel.style.height = `${renderedHeight * charityLayout.machine.height}px`;
    }
  };
  if (stage && background) {
    new ResizeObserver(alignOverlaysToVideo).observe(stage);
    background.addEventListener(background.tagName === 'IMG' ? 'load' : 'loadedmetadata', alignOverlaysToVideo);
    alignOverlaysToVideo();
  }
  historyPanel.style.display = 'flex';
  historyPanel.style.flexDirection = 'column';
  historyPanel.style.overflow = 'hidden';
  const historyHeader = historyPanel.querySelector('.history-head');
  if (historyHeader) historyHeader.style.flexShrink = '0';
  const historyList = document.querySelector('#historyList');
  if (historyList) {
    historyList.style.gap = '3px';
    historyList.style.paddingTop = '8px';
    historyList.style.flex = '1 1 0';
    historyList.style.minHeight = '0';
    historyList.style.maxHeight = 'none';
    historyList.style.overflowX = 'hidden';
    historyList.style.overflowY = 'auto';
  }
  const prizePanel = document.querySelector('#prizePanel');
  if (prizePanel) {
    prizePanel.style.position = 'relative';
    prizePanel.style.left = 'auto';
    prizePanel.style.top = 'auto';
    prizePanel.style.width = '100%';
    prizePanel.style.height = 'clamp(128px, 19vh, 190px)';
    prizePanel.style.flex = '0 0 clamp(128px, 19vh, 190px)';
  }
}
setInterval(() => {
  if (operatorPage || !wsReady) return;
  if (!lastReceived || performance.now() - lastReceived > 4000) {
    const status = document.querySelector('#syncStatus');
    if (status) {
      status.dataset.state = 'connecting';
      status.querySelector('span').textContent = '中继已连接，等待操作端';
    }
  }
}, 1000);

async function init() {
  if (location.hostname.endsWith('.github.io')) {
    const { configureOnlineSync } = await import('./online-setup.js');
    WS_TOKEN = await configureOnlineSync(WS_TOKEN);
  }
  await loadEventRoster();
  connect();
  reset(false);
  renderHistory();
  ensureManualToggle();
  if (operatorPage && people.length) {
    showNotice(`已装入 ${people.length} 位抽奖嘉宾；按左右键切换奖品，空格按 Excel 批次抽取。`);
  }
  if (operatorPage) startCamera();
  step();
}

init();
