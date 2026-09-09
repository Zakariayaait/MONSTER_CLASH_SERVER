const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const rooms = new Map();
const CHAR_LIMIT = 11;
const ROOM_TTL = 60 * 60 * 1000;

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }));
}
function broadcast(room, type, payload = {}) {
  send(room.p1?.ws, type, payload);
  send(room.p2?.ws, type, payload);
}
function cleanName(v) {
  return String(v || 'لاعب').replace(/[<>]/g, '').trim().slice(0, 18) || 'لاعب';
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length: 6}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); } while (rooms.has(code));
  return code;
}
function publicPlayer(p) {
  if (!p) return null;
  return { name: p.name, ready: !!p.ready };
}
function publicRoom(room) {
  return { code: room.code, players: { p1: publicPlayer(room.p1), p2: publicPlayer(room.p2) }, battle: room.battle ? publicBattle(room.battle) : null };
}
function publicUnit(u) { return { id:u.id, name:u.name, icon:u.icon, hp:u.hp, maxHp:u.maxHp, dead:!!u.dead }; }
function publicSide(s) { return { name:s.name, units:s.units.map(publicUnit) }; }
function publicBattle(b) { return { turn:b.turn, finished:b.finished, winner:b.winner, logs:b.logs.slice(-80), p1:publicSide(b.p1), p2:publicSide(b.p2) }; }
function roomState(room) { return publicRoom(room); }
function broadcastRoom(room) { broadcast(room, 'room_state', { room: roomState(room), side: undefined }); }
function sendRoomStateTo(room, player, side) { send(player.ws, 'room_state', { room: roomState(room), side }); }

function sanitizeTeam(team) {
  if (!Array.isArray(team) || team.length !== CHAR_LIMIT) return null;
  const seen = new Set();
  const out = [];
  for (const raw of team) {
    if (!raw || seen.has(String(raw.id))) return null;
    seen.add(String(raw.id));
    const hp = Number(raw.hp), atk = Number(raw.atk), def = Number(raw.def), spd = Number(raw.spd);
    if (![hp, atk, def, spd].every(Number.isFinite)) return null;
    if (hp < 1 || hp > 1000000 || atk < 1 || atk > 100000 || def < 0 || def > 100000 || spd < 1 || spd > 10000) return null;
    out.push({ id: String(raw.id), name: cleanName(raw.name || 'وحش'), icon: String(raw.icon || '👾').slice(0, 8), hp: Math.round(hp), maxHp: Math.round(hp), atk: Math.round(atk), def: Math.round(def), spd: Math.round(spd), dead:false });
  }
  return out;
}
function activeUnits(side) { return side.units.filter(u => !u.dead && u.hp > 0); }
function startBattle(room) {
  const makeSide = p => ({ name:p.name, units:p.team.map(u => ({...u, hp:u.maxHp, dead:false})) });
  room.battle = { turn:0, finished:false, winner:null, logs:['⚔️ بدأت المعركة!'], p1:makeSide(room.p1), p2:makeSide(room.p2) };
  tickBattle(room);
}
function attackOnce(attacker, defender) {
  const target = activeUnits(defender)[Math.floor(Math.random() * activeUnits(defender).length)];
  if (!target) return null;
  const raw = Math.max(1, attacker.atk - Math.floor(target.def * 0.45));
  const variance = 0.85 + Math.random() * 0.30;
  const damage = Math.max(1, Math.round(raw * variance));
  target.hp = Math.max(0, target.hp - damage);
  if (target.hp === 0) target.dead = true;
  return { target, damage };
}
function tickBattle(room) {
  if (!room.battle || room.battle.finished) return;
  const b = room.battle;
  b.turn++;
  const order = [
    ...activeUnits(b.p1).map(u=>({u,side:b.p1,enemy:b.p2})),
    ...activeUnits(b.p2).map(u=>({u,side:b.p2,enemy:b.p1}))
  ].sort((a,z)=>z.u.spd-a.u.spd);
  for (const a of order) {
    if (a.u.dead || activeUnits(a.enemy).length === 0) continue;
    const result = attackOnce(a.u, a.enemy);
    if (result) {
      b.logs.push(`⚡ ${a.u.name} هاجم ${result.target.name} وألحق ${result.damage} ضرر.`);
      if (result.target.dead) b.logs.push(`💥 ${result.target.name} خرج من المعركة.`);
    }
    if (activeUnits(a.enemy).length === 0) break;
  }
  const p1Alive = activeUnits(b.p1).length, p2Alive = activeUnits(b.p2).length;
  if (!p1Alive || !p2Alive) {
    b.finished = true;
    b.winner = p1Alive ? 'p1' : 'p2';
    b.logs.push(`🏆 الفائز: ${b[b.winner].name}`);
    broadcast(room, 'battle_state', { battle: publicBattle(b) });
    return;
  }
  broadcast(room, 'battle_state', { battle: publicBattle(b) });
  room.timer = setTimeout(() => tickBattle(room), 1200);
}
function detach(ws) {
  for (const room of rooms.values()) {
    let side = null;
    if (room.p1?.ws === ws) side = 'p1';
    if (room.p2?.ws === ws) side = 'p2';
    if (!side) continue;
    const other = side === 'p1' ? room.p2 : room.p1;
    if (room.timer) clearTimeout(room.timer);
    rooms.delete(room.code);
    if (other) send(other.ws, 'room_closed', { message:'الخصم خرج من الغرفة.' });
    return;
  }
}

const httpServer = http.createServer((req,res)=>{
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true,rooms:rooms.size})); }
  res.writeHead(200, {'content-type':'text/plain; charset=utf-8'}); res.end('Monster Clash Online Server is running.');
});
const wss = new WebSocketServer({ server:httpServer });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return send(ws,'error',{message:'رسالة غير صالحة.'}); }
    const type = m.type;
    if (type === 'create_room') {
      detach(ws);
      const room = { code:makeCode(), p1:{ws,name:cleanName(m.name),ready:false,team:null}, p2:null, battle:null, timer:null, createdAt:Date.now() };
      rooms.set(room.code, room);
      ws.roomCode=room.code; ws.side='p1';
      send(ws,'room_created',{room:roomState(room),side:'p1'}); return;
    }
    if (type === 'join_room') {
      const code=String(m.code||'').toUpperCase(); const room=rooms.get(code);
      if (!room) return send(ws,'error',{message:'الغرفة غير موجودة.'});
      if (room.p2) return send(ws,'error',{message:'الغرفة ممتلئة.'});
      if (room.p1.ws===ws) return send(ws,'error',{message:'أنت داخل الغرفة أصلاً.'});
      room.p2={ws,name:cleanName(m.name),ready:false,team:null}; ws.roomCode=code; ws.side='p2';
      send(ws,'room_joined',{room:roomState(room),side:'p2'}); send(room.p1.ws,'room_state',{room:roomState(room),side:'p1'}); return;
    }
    const code=ws.roomCode, room=rooms.get(code);
    if (!room) return send(ws,'error',{message:'ما عندكش غرفة نشطة.'});
    const me=ws.side==='p1'?room.p1:room.p2;
    if (type === 'ready') {
      const want=!!m.ready;
      if (want) { const team=sanitizeTeam(m.team); if (!team) return send(ws,'error',{message:'الفريق خاصو يكون فيه 11 وحش صالح.'}); me.team=team; me.ready=true; }
      else { me.ready=false; me.team=null; }
      if (room.p1?.ready && room.p2?.ready && room.p1.team && room.p2.team) startBattle(room);
      else { sendRoomStateTo(room, room.p1, 'p1'); if(room.p2) sendRoomStateTo(room,room.p2,'p2'); }
      return;
    }
    if (type === 'return_lobby') {
      if (room.timer) { clearTimeout(room.timer); room.timer=null; }
      room.battle=null; room.p1.ready=false; room.p1.team=null; if(room.p2){room.p2.ready=false;room.p2.team=null;}
      sendRoomStateTo(room,room.p1,'p1'); if(room.p2) sendRoomStateTo(room,room.p2,'p2'); return;
    }
    if (type === 'leave_room') {
      const other=ws.side==='p1'?room.p2:room.p1;
      if (room.timer) clearTimeout(room.timer);
      rooms.delete(code); ws.roomCode=null; ws.side=null;
      send(ws,'room_closed',{message:'خرجتي من الغرفة.'}); if(other) send(other.ws,'room_closed',{message:'الخصم خرج من الغرفة.'}); return;
    }
  });
  ws.on('close',()=>detach(ws));
  ws.on('error',()=>detach(ws));
});

setInterval(()=>{
  const now=Date.now();
  for (const [code,room] of rooms) if (now-room.createdAt>ROOM_TTL) { if(room.timer)clearTimeout(room.timer); broadcast(room,'room_closed',{message:'انتهت صلاحية الغرفة.'}); rooms.delete(code); }
  for (const ws of wss.clients) { if (!ws.isAlive) { try{ws.terminate()}catch{}; continue; } ws.isAlive=false; try{ws.ping()}catch{} }
},30000);

process.on('SIGTERM',()=>{ for(const room of rooms.values()) { if(room.timer)clearTimeout(room.timer); broadcast(room,'room_closed',{message:'السيرفر كيدير إعادة تشغيل، عاود دخل للغرفة.'}); } httpServer.close(()=>process.exit(0)); setTimeout(()=>process.exit(0),5000); });
httpServer.listen(PORT,'0.0.0.0',()=>console.log(`Monster Clash Online listening on ${PORT}`));
  
