(() => {
  "use strict";

  /**********************
   * CONFIG
   **********************/
  const BASE_W = 960, BASE_H = 540;
  const TILE = 24;

  // PULO (ajustado: não fica alto demais)
  const GRAV = 1700;
  const JUMP_V = -600;       // antes estava muito alto
  const JUMP_HOLD = 0.10;    // segurar dá um pouquinho a mais
  const MAX_FALL = 1200;

  const SAVE_KEY = "aloLilinha_save_split_v1";

  /**********************
   * DOM
   **********************/
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d", { alpha: false });
  canvas.width = BASE_W;
  canvas.height = BASE_H;

  const overlay = document.getElementById("overlay");
  const saveBadge = document.getElementById("saveBadge");
  const btnPlay = document.getElementById("btnPlay");
  const btnContinue = document.getElementById("btnContinue");
  const btnReset = document.getElementById("btnReset");
  const menuObjective = document.getElementById("menuObjective");
  const menuSubtitle = document.getElementById("menuSubtitle");
  const buildInfo = document.getElementById("buildInfo");
  const hintEl = document.getElementById("hint");
  const touchUI = document.getElementById("touchUI");

  buildInfo.textContent = "v2 (split) • " + new Date().toLocaleDateString("pt-BR");

  /**********************
   * UTILS
   **********************/
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const lerp = (a,b,t) => a + (b-a)*t;

  function showHint(text, ms=1400){
    hintEl.textContent = text;
    hintEl.style.display = "block";
    clearTimeout(showHint._t);
    showHint._t = setTimeout(()=> hintEl.style.display = "none", ms);
  }

  function aabb(ax,ay,aw,ah,bx,by,bw,bh){
    return ax < bx+bw && ax+aw > bx && ay < by+bh && ay+ah > by;
  }

  function isTouch(){
    return (navigator.maxTouchPoints || 0) > 0 || "ontouchstart" in window;
  }

  /**********************
   * AUDIO (tiny beeps)
   **********************/
  const audio = (() => {
    let ctxA = null;
    function beep(freq=440, dur=0.06, type="square", vol=0.05){
      try{
        if(!ctxA) ctxA = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctxA.createOscillator();
        const g = ctxA.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.value = vol;
        o.connect(g); g.connect(ctxA.destination);
        o.start();
        o.stop(ctxA.currentTime + dur);
      }catch(_){}
    }
    return { beep };
  })();

  /**********************
   * INPUT
   **********************/
  const Keys = new Set();
  const Pressed = new Set();
  const pad = { left:false, right:false, jump:false, interact:false, run:false };

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    Keys.add(k);
    if(!e.repeat) Pressed.add(k);
    const block = ["arrowleft","arrowright","arrowup"," "];
    if(block.includes(k) || e.key===" " || e.key==="ArrowLeft" || e.key==="ArrowRight" || e.key==="ArrowUp"){
      e.preventDefault();
    }
  }, { passive:false });

  window.addEventListener("keyup", (e) => {
    Keys.delete(e.key.toLowerCase());
  });

  const down = (k) => Keys.has(k);
  const pressed = (k) => Pressed.has(k);
  const clearPressed = () => { Pressed.clear(); pad.interact = false; };

  function bindTouchBtn(id, setter){
    const el = document.getElementById(id);
    const start = (e)=>{ e.preventDefault(); setter(true); };
    const end = (e)=>{ e.preventDefault(); setter(false); };
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", end);
  }

  if(isTouch()){
    touchUI.style.display = "flex";
    bindTouchBtn("tLeft", v => pad.left = v);
    bindTouchBtn("tRight", v => pad.right = v);
    bindTouchBtn("tJump", v => pad.jump = v);
    bindTouchBtn("tInteract", v => pad.interact = v);
    showHint("Controles touch ativados");
  }

  document.addEventListener("touchmove", (e)=> {
    if(e.target === canvas) e.preventDefault();
  }, { passive:false });

  /**********************
   * DRAW HELPERS
   **********************/
  function pixRect(x,y,w,h,color){
    ctx.fillStyle = color;
    ctx.fillRect(x|0,y|0,w|0,h|0);
  }
  function pixText(text, x, y, size=12, color="#e5e7eb", align="left"){
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = "top";
    ctx.fillText(text, x|0, y|0);
    ctx.restore();
  }
  function vignette(str=0.52){
    const g = ctx.createRadialGradient(BASE_W/2, BASE_H/2, 60, BASE_W/2, BASE_H/2, Math.max(BASE_W,BASE_H)*0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${str})`);
    ctx.fillStyle = g;
    ctx.fillRect(0,0,BASE_W,BASE_H);
  }
  function hash2(x,y){
    let n = (x*374761393 + y*668265263) ^ (x<<13);
    n = (n ^ (n>>17)) * 1274126177;
    n = n ^ (n>>16);
    return ((n>>>0) % 10000) / 10000;
  }

  /**********************
   * TILES
   **********************/
  const T = {
    EMPTY: 0,
    BRICK: 1,
    STONE: 2,
    METAL: 3,
    DIRT:  4,
    GRASS: 5,
    ROAD:  6,
    PIPE:  7,
    HOUSE: 8,
    SPIKE: 9,
    LASER: 10,
  };

  const solid = (t) =>
    t===T.BRICK||t===T.STONE||t===T.METAL||t===T.DIRT||t===T.GRASS||t===T.ROAD||t===T.PIPE||t===T.HOUSE;

  const hazard = (t) => t===T.SPIKE || t===T.LASER;

  /**********************
   * LEVELS
   * (Porta da cela foi movida e agora é um OBJETO “door” com posição certinha)
   **********************/
  function level1(){
    const w=120,h=22;
    const tiles = new Array(w*h).fill(T.EMPTY);
    const set = (x,y,v)=>{ if(x>=0&&y>=0&&x<w&&y<h) tiles[y*w+x]=v; };
    const get = (x,y)=> (x<0||y<0||x>=w||y>=h) ? T.STONE : tiles[y*w+x];

    // chão
    for(let x=0;x<w;x++){
      for(let y=h-4;y<h;y++){
        set(x,y, y===h-4 ? T.BRICK : T.STONE);
      }
    }

    // paredes externas do bloco da prisão (primeira área)
    for(let x=0;x<44;x++){
      for(let y=0;y<h-4;y++){
        if(y===0 || y===h-5 || x===0 || x===43) set(x,y,T.BRICK);
      }
    }

    // cela (um “quartinho” no canto esquerdo inferior)
    // bloco de paredes
    for(let x=3;x<=14;x++){
      for(let y=13;y<=17;y++){
        if(x===3 || x===14 || y===13 || y===17) set(x,y,T.BRICK);
      }
    }
    // abertura para a porta no lado direito da cela (2 tiles de altura)
    set(14,16,T.EMPTY);
    set(14,15,T.EMPTY);

    // plataformas pra pegar a chave
    for(let x=18;x<36;x++) set(x,14,T.BRICK);
    for(let x=26;x<38;x++) set(x,10,T.BRICK);

    // corredor + armadilhas
    for(let x=44;x<w;x++){
      set(x,h-4,T.METAL);
      if(x%7===0 && x>54 && x<78) set(x,h-5,T.SPIKE);
    }
    for(let x=62;x<78;x++) set(x,h-8,T.METAL);

    // retorno
    return {
      id:1, name:"Prisão", theme:"prison",
      w,h,tiles,get,set,
      spawn: { x: 6*TILE, y: (h-4)*TILE - 18 },
      checkpoint: { x: 60*TILE, y: (h-7)*TILE },
      exit: { x: 112*TILE, y: (h-8)*TILE, w: 3*TILE, h: 5*TILE },
      objectives: [
        "Encontre a chave!",
        "Abra o portão da prisão!",
        "Corra até a saída!"
      ],
      // portas (AGORA OBJETOS, não tiles)
      doors: [
        // Porta da cela (destravada): posição no buraco da parede (x=14, y=15..16)
        { id:"cell", x: 14*TILE, y: (16*TILE - TILE), w:TILE, h:TILE*2, locked:false },
        // Portão principal (TRANCADO): precisa da chave
        { id:"gate", x: 40*TILE, y: (h-4)*TILE - TILE*2, w:TILE, h:TILE*2, locked:true },
      ],
      pickups: [
        { kind:"key", x: 30*TILE+5, y: 14*TILE-18 },  // chave numa plataforma alcançável
        { kind:"bone", x: 34*TILE+5, y: 10*TILE-18 },
        { kind:"treat", x: 58*TILE+5, y: (h-7)*TILE-18 },
        { kind:"checkpoint", x: 60*TILE+5, y: (h-7)*TILE-18 }
      ],
      enemies: [
        { kind:"guard", x: 22*TILE, y: (h-5)*TILE-20, dir: 1, patrol: 6*TILE },
        { kind:"guard", x: 70*TILE, y: (h-5)*TILE-20, dir:-1, patrol: 7*TILE },
        { kind:"drone", x: 54*TILE, y: 9*TILE },
        { kind:"saw",   x: 84*TILE, y: (h-5)*TILE-18 }
      ],
    };
  }

  function level2(){
    const w=130,h=22;
    const tiles = new Array(w*h).fill(T.EMPTY);
    const set=(x,y,v)=>{ if(x>=0&&y>=0&&x<w&&y<h) tiles[y*w+x]=v; };
    const get=(x,y)=> (x<0||y<0||x>=w||y>=h) ? T.STONE : tiles[y*w+x];

    for(let x=0;x<w;x++){
      for(let y=h-4;y<h;y++){
        set(x,y, y===h-4 ? (x<55?T.ROAD:T.PIPE) : T.STONE);
      }
    }

    for(let x=10;x<26;x++) set(x,12,T.METAL);
    for(let x=22;x<34;x++) set(x,9,T.METAL);
    for(let x=58;x<74;x++) set(x,11,T.METAL);
    for(let x=78;x<98;x++) set(x,8,T.METAL);
    for(let x=96;x<112;x++) set(x,12,T.METAL);

    // laser no caminho
    for(let x=44;x<56;x++){
      set(x,14,T.METAL);
      if(x>=46 && x<=54) set(x,13,T.LASER);
    }

    // paredes laterais
    for(let y=0;y<h-4;y++){ set(0,y,T.STONE); set(w-1,y,T.STONE); }

    return {
      id:2, name:"Ruas & Esgoto", theme:"sewer",
      w,h,tiles,get,set,
      spawn: { x: 4*TILE, y: 10*TILE },
      checkpoint: { x: 68*TILE, y: 9*TILE },
      exit: { x: 124*TILE, y: (h-9)*TILE, w: 4*TILE, h: 6*TILE },
      objectives: [
        "Atravesse o esgoto!",
        "Cuidado com lasers e serras!",
        "Siga em frente: o cheirinho de casa tá perto!"
      ],
      doors: [],
      pickups: [
        { kind:"bone", x: 18*TILE+5, y: 12*TILE-18 },
        { kind:"treat", x: 60*TILE+5, y: 11*TILE-18 },
        { kind:"bone", x: 94*TILE+5, y: 8*TILE-18 },
        { kind:"checkpoint", x: 68*TILE+5, y: 9*TILE-18 }
      ],
      enemies: [
        { kind:"guard", x: 28*TILE, y: (h-5)*TILE-20, dir: 1, patrol: 7*TILE },
        { kind:"saw",   x: 44*TILE, y: (h-5)*TILE-18 },
        { kind:"drone", x: 70*TILE, y: 7*TILE },
        { kind:"drone", x: 102*TILE, y: 9*TILE }
      ],
    };
  }

  function level3(){
    const w=140,h=22;
    const tiles = new Array(w*h).fill(T.EMPTY);
    const set=(x,y,v)=>{ if(x>=0&&y>=0&&x<w&&y<h) tiles[y*w+x]=v; };
    const get=(x,y)=> (x<0||y<0||x>=w||y>=h) ? T.STONE : tiles[y*w+x];

    for(let x=0;x<w;x++){
      const surface = (x<25) ? h-4 : (x<55) ? h-5 : (x<90) ? h-4 : (x<118) ? h-6 : h-4;
      for(let y=surface;y<h;y++){
        set(x,y, y===surface ? (x<90?T.GRASS:T.ROAD) : T.DIRT);
      }
    }

    for(let x=16;x<32;x++) set(x,12,T.DIRT);
    for(let x=32;x<44;x++) set(x,10,T.DIRT);
    for(let x=96;x<110;x++) set(x,9,T.METAL);

    // casinha
    for(let x=125;x<138;x++){
      for(let y=6;y<14;y++){
        if(y===6||y===13||x===125||x===137) set(x,y,T.HOUSE);
      }
    }

    // espinhos
    for(let x=92;x<100;x++){ if(x%2===0) set(x, (h-5), T.SPIKE); }

    return {
      id:3, name:"Caminho de Casa", theme:"neighborhood",
      w,h,tiles,get,set,
      spawn: { x: 4*TILE, y: 10*TILE },
      checkpoint: { x: 86*TILE, y: 9*TILE },
      exit: { x: 129*TILE, y: 7*TILE, w: 6*TILE, h: 8*TILE },
      objectives: [
        "Última corrida!",
        "Evite armadilhas e curiosos.",
        "Toque a porta de casa e vença!"
      ],
      doors: [],
      pickups: [
        { kind:"treat", x: 24*TILE+5, y: 10*TILE-18 },
        { kind:"bone",  x: 40*TILE+5, y: 10*TILE-18 },
        { kind:"bone",  x: 76*TILE+5, y: 11*TILE-18 },
        { kind:"checkpoint", x: 86*TILE+5, y: 9*TILE-18 }
      ],
      enemies: [
        { kind:"guard", x: 58*TILE, y: (h-5)*TILE-20, dir: 1, patrol: 9*TILE },
        { kind:"guard", x: 98*TILE, y: (h-6)*TILE-20, dir:-1, patrol: 8*TILE },
        { kind:"drone", x: 110*TILE, y: 7*TILE },
        { kind:"saw",   x: 92*TILE,  y: (h-5)*TILE-18 }
      ],
    };
  }

  const LEVELS = [level1, level2, level3];

  /**********************
   * ENTITIES
   **********************/
  function newPlayer(){
    return {
      x:0,y:0,vx:0,vy:0,w:18,h:18,
      onGround:false, face:1,
      run:false,
      jumpBuf:0, coyote:0, jumpHold:0,
      inv:0,
      hp:5, maxHp:5,
      bones:0, treats:0, hasKey:false,
      respawnX:0, respawnY:0,
      objectiveStep:0,
      animT:0, blink:0
    };
  }

  function makeGuard(cfg){
    return {
      kind:"guard",
      x:cfg.x, y:cfg.y,
      w:18, h:20,
      vx: 70 * (cfg.dir||1),
      vy: 0,
      face: (cfg.dir||1),
      minX: cfg.x - (cfg.patrol|| (6*TILE)),
      maxX: cfg.x + (cfg.patrol|| (6*TILE)),
      saw:0,
      cd:0
    };
  }

  function makeDrone(cfg){
    return {
      kind:"drone",
      x:cfg.x, y:cfg.y,
      w:18, h:12,
      t: Math.random()*10,
      baseY: cfg.y,
      laser:0
    };
  }

  function makeSaw(cfg){
    return {
      kind:"saw",
      x:cfg.x, y:cfg.y,
      w:18, h:18,
      t: Math.random()*10,
      baseX: cfg.x,
      range: 5*TILE
    };
  }

  function makeChaser(x,y){
    return { kind:"chaser", x,y,w:18,h:18,vx:0,vy:0,face:1,ttl:10,onGround:false };
  }

  function makeDoor(d){
    return { ...d, open:false };
  }

  function makePickup(p){
    return { ...p, w:14, h:14, t:0, taken:false };
  }

  /**********************
   * STATE
   **********************/
  const S = {
    mode: "menu", // menu/playing/paused/gameover/win
    time: 0,
    dt: 0,
    levelIndex: 0,
    L: null,
    player: newPlayer(),
    entities: [],
    doors: [],
    pickups: [],
    alert: 0,
    alertSpawned: false,
    camX: 0,
    camY: 0,
    shake: 0,
    msg: "",
    msgT: 0,
    particles: []
  };

  /**********************
   * SAVE / LOAD
   **********************/
  function saveGame(){
    const p = S.player;
    const data = {
      levelIndex: S.levelIndex,
      hp: p.hp, maxHp: p.maxHp,
      bones: p.bones, treats: p.treats,
      hasKey: p.hasKey,
      objectiveStep: p.objectiveStep,
      respawnX: p.respawnX, respawnY: p.respawnY,
      alert: S.alert
    };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    updateSaveBadge();
  }

  function loadGame(){
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return null;
    try{ return JSON.parse(raw); }catch(_){ return null; }
  }

  function clearSave(){
    localStorage.removeItem(SAVE_KEY);
    updateSaveBadge();
  }

  function updateSaveBadge(){
    const s = loadGame();
    if(!s){
      saveBadge.innerHTML = `Progresso: <b>Novo</b>`;
      btnContinue.disabled = true;
    }else{
      saveBadge.innerHTML = `Progresso: <b>Fase ${ (s.levelIndex||0)+1 }</b>`;
      btnContinue.disabled = false;
    }
  }
  updateSaveBadge();

  /**********************
   * MODE
   **********************/
  function setMode(m){
    S.mode = m;
    overlay.style.display = (m==="menu") ? "flex" : "none";
  }

  function setMessage(text, t=1.8){
    S.msg = text;
    S.msgT = t;
  }

  function togglePause(){
    if(S.mode==="playing"){
      S.mode="paused";
      setMode("menu");
      menuSubtitle.textContent = "Pausado. Lili foi cheirar o vento. (Prioridades.)";
      btnPlay.textContent = "Voltar";
      btnContinue.style.display = "none";
      menuObjective.textContent = "Pressione P para continuar.";
    } else if(S.mode==="paused"){
      S.mode="playing";
      setMode("playing");
      btnContinue.style.display = "";
      btnPlay.textContent = "Jogar";
      menuSubtitle.textContent =
        "Lili está fugindo da prisão pra voltar pra casa. Pegue a chave, abra o portão e fuja sem disparar o alarme!";
    }
  }

  /**********************
   * PHYSICS
   **********************/
  function tileAt(wx,wy){
    const L = S.L;
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    return L.get(tx,ty);
  }

  function moveAndCollide(ent, dt){
    const L = S.L;

    // H
    ent.x += ent.vx*dt;

    // portas bloqueiam
    for(const d of S.doors){
      if(!d.open && aabb(ent.x,ent.y,ent.w,ent.h, d.x,d.y,d.w,d.h)){
        if(ent.vx>0) ent.x = d.x - ent.w;
        else if(ent.vx<0) ent.x = d.x + d.w;
        ent.vx = 0;
      }
    }

    if(ent.vx !== 0){
      const dir = Math.sign(ent.vx);
      const aheadX = dir>0 ? ent.x+ent.w : ent.x;
      const top = ent.y+1;
      const bottom = ent.y+ent.h-1;
      const y0 = Math.floor(top/TILE);
      const y1 = Math.floor(bottom/TILE);
      const tx = Math.floor(aheadX/TILE);
      for(let ty=y0; ty<=y1; ty++){
        const t = L.get(tx,ty);
        if(solid(t)){
          if(dir>0) ent.x = tx*TILE - ent.w;
          else ent.x = (tx+1)*TILE;
          ent.vx = 0;
          break;
        }
      }
    }

    // V
    ent.y += ent.vy*dt;
    ent.onGround = false;

    for(const d of S.doors){
      if(!d.open && aabb(ent.x,ent.y,ent.w,ent.h, d.x,d.y,d.w,d.h)){
        if(ent.vy>0){
          ent.y = d.y - ent.h;
          ent.vy = 0;
          ent.onGround = true;
        }else if(ent.vy<0){
          ent.y = d.y + d.h;
          ent.vy = 0;
        }
      }
    }

    if(ent.vy !== 0){
      const dir = Math.sign(ent.vy);
      const probeY = dir>0 ? ent.y+ent.h : ent.y;
      const left = ent.x+2;
      const right = ent.x+ent.w-2;
      const x0 = Math.floor(left/TILE);
      const x1 = Math.floor(right/TILE);
      const ty = Math.floor(probeY/TILE);
      for(let tx=x0; tx<=x1; tx++){
        const t = L.get(tx,ty);
        if(solid(t)){
          if(dir>0){
            ent.y = ty*TILE - ent.h;
            ent.vy = 0;
            ent.onGround = true;
          }else{
            ent.y = (ty+1)*TILE;
            ent.vy = 0;
          }
          break;
        }
      }
    }
  }

  /**********************
   * PARTICLES
   **********************/
  function burst(x,y,count,color){
    for(let i=0;i<count;i++){
      S.particles.push({
        x,y,
        vx:(Math.random()*2-1)*160,
        vy:(Math.random()*2-1)*180-60,
        life:0.6+Math.random()*0.35,
        color
      });
    }
  }
  function updateParticles(dt){
    for(const p of S.particles){
      p.life -= dt;
      p.vy += 900*dt;
      p.x += p.vx*dt;
      p.y += p.vy*dt;
      p.vx *= Math.pow(0.01, dt);
      if(solid(tileAt(p.x, p.y+2)) && p.vy>0){
        p.vy *= -0.35;
        p.vx *= 0.7;
      }
    }
    S.particles = S.particles.filter(p=>p.life>0);
  }
  function drawParticles(camX,camY){
    for(const p of S.particles){
      const a = clamp(p.life/0.8,0,1);
      ctx.save();
      ctx.globalAlpha = a;
      pixRect(p.x-camX, p.y-camY, 2,2, p.color);
      ctx.globalAlpha = a*0.25;
      pixRect(p.x-camX-1, p.y-camY-1, 4,4, p.color);
      ctx.restore();
    }
  }

  /**********************
   * SPRITES (procedural pixel art)
   **********************/
  function drawBackground(theme, camX){
    if(theme==="prison"){
      const g = ctx.createLinearGradient(0,0,0,BASE_H);
      g.addColorStop(0,"#0a1022");
      g.addColorStop(0.55,"#060816");
      g.addColorStop(1,"#04050d");
      ctx.fillStyle = g; ctx.fillRect(0,0,BASE_W,BASE_H);
      for(let i=0;i<28;i++){
        const x = ((i*56 - camX*0.18 + (S.time*14)) % (BASE_W+120)) - 60;
        pixRect(x, 0, 10, BASE_H, "rgba(148,163,184,0.05)");
        pixRect(x+3, 0, 2, BASE_H, "rgba(0,0,0,0.10)");
      }
    } else if(theme==="sewer"){
      const g = ctx.createLinearGradient(0,0,0,BASE_H);
      g.addColorStop(0,"#071c17");
      g.addColorStop(0.6,"#050a10");
      g.addColorStop(1,"#03040b");
      ctx.fillStyle = g; ctx.fillRect(0,0,BASE_W,BASE_H);
      for(let i=0;i<10;i++){
        const x = ((i*150 - camX*0.25) % (BASE_W+260)) - 140;
        pixRect(x, 110, 140, 34, "rgba(16,185,129,0.06)");
        pixRect(x+18, 58, 34, 90, "rgba(16,185,129,0.05)");
      }
    } else {
      const g = ctx.createLinearGradient(0,0,0,BASE_H);
      g.addColorStop(0,"#0b1a3a");
      g.addColorStop(0.35,"#07112a");
      g.addColorStop(1,"#04050d");
      ctx.fillStyle = g; ctx.fillRect(0,0,BASE_W,BASE_H);
      for(let i=0;i<70;i++){
        const sx = (i*157 + Math.floor(camX*0.10)) % (BASE_W+200) - 100;
        const sy = (i*73) % BASE_H;
        const a = 0.12 + (i%6)*0.02;
        pixRect(sx, sy, 2, 2, `rgba(255,255,255,${a})`);
      }
    }
  }

  function drawTile(id, sx, sy, tx, ty){
    const n = hash2(tx,ty);
    const n2 = hash2(tx+9,ty-7);
    const hi = "rgba(255,255,255,0.08)";
    const sh = "rgba(0,0,0,0.22)";

    if(id===T.BRICK){
      const base = (n<0.5) ? "#6b2a2a" : "#612424";
      pixRect(sx,sy,TILE,TILE,base);
      pixRect(sx,sy+7,TILE,1,sh);
      pixRect(sx,sy+14,TILE,1,sh);
      const shift = (ty%2===0) ? 10 : 4;
      pixRect(sx+shift,sy,1,7,"rgba(0,0,0,0.18)");
      pixRect(sx+(shift+8),sy+7,1,TILE-7,"rgba(0,0,0,0.18)");
      if(n2>0.62) pixRect(sx+3,sy+3,4,2,hi);
    } else if(id===T.STONE){
      const base = (n<0.5) ? "#3f454e" : "#3a4048";
      pixRect(sx,sy,TILE,TILE,base);
      pixRect(sx+2,sy+3,6,3,hi);
      pixRect(sx+12,sy+11,6,4,"rgba(0,0,0,0.24)");
    } else if(id===T.METAL){
      const base = (n<0.45) ? "#374151" : "#2f3947";
      pixRect(sx,sy,TILE,TILE,base);
      pixRect(sx,sy,TILE,3,"#4b5563");
      pixRect(sx+3,sy+6,TILE-6,1,"rgba(255,255,255,0.12)");
      if((tx+ty)%3===0){
        pixRect(sx+4,sy+4,2,2,"rgba(255,255,255,0.10)");
        pixRect(sx+TILE-6,sy+TILE-6,2,2,"rgba(0,0,0,0.22)");
      }
    } else if(id===T.DIRT){
      const base = n<0.5 ? "#4a2f1f" : "#402a1d";
      pixRect(sx,sy,TILE,TILE,base);
      pixRect(sx,sy+TILE-6,TILE,6,"#2d1c13");
    } else if(id===T.GRASS){
      pixRect(sx,sy,TILE,TILE,"#2f241a");
      pixRect(sx,sy,TILE,7,(n<0.33) ? "#1faa59" : "#169a4c");
    } else if(id===T.ROAD){
      pixRect(sx,sy,TILE,TILE,(n<0.5) ? "#1f2937" : "#1b2430");
      pixRect(sx+2,sy+2,TILE-4,TILE-4,"rgba(255,255,255,0.03)");
    } else if(id===T.PIPE){
      pixRect(sx,sy,TILE,TILE,"#0b3a2b");
      pixRect(sx+2,sy+3,TILE-4,TILE-6,"#115e46");
      pixRect(sx+4,sy+6,TILE-8,2,"rgba(255,255,255,0.10)");
    } else if(id===T.HOUSE){
      pixRect(sx,sy,TILE,TILE,"#7c2d12");
      pixRect(sx+2,sy+2,TILE-4,TILE-4,"#9a3412");
    } else if(id===T.SPIKE){
      pixRect(sx,sy,TILE,TILE,"rgba(255,255,255,0.02)");
      for(let i=0;i<3;i++){
        const x = sx + 3 + i*7;
        pixRect(x, sy+TILE-6, 4, 6, "#e5e7eb");
        pixRect(x+1, sy+TILE-6, 2, 2, "rgba(0,0,0,0.20)");
      }
    } else if(id===T.LASER){
      pixRect(sx,sy,TILE,TILE,"rgba(239,68,68,0.10)");
      pixRect(sx+2,sy+TILE-4,TILE-4,2,"rgba(239,68,68,0.45)");
    }
  }

  function drawLili(p, sx, sy){
    const frame = Math.floor(p.animT*10) % 4;
    const flip = p.face < 0;
    const w = p.w, h = p.h;

    ctx.save();
    ctx.translate((sx + w/2)|0, (sy + h/2)|0);
    ctx.scale(flip ? -1 : 1, 1);
    ctx.translate((-w/2)|0, (-h/2)|0);

    const fur = "#d08c3f";
    const fur2 = "#b9722b";
    const fur3 = "#8a4f1b";
    const dark = "#0b1220";
    const shine = "rgba(255,255,255,0.10)";
    const wag = Math.sin(S.time*10) * 2;

    ctx.save();
    ctx.globalAlpha = 0.25;
    pixRect(3, h-2, 12, 2, "rgba(0,0,0,0.8)");
    ctx.restore();

    pixRect(2,7,14,8,fur);
    pixRect(3,8,12,6,fur2);

    pixRect(10,3,8,7,fur);
    pixRect(11,4,6,5,fur2);

    pixRect(10,2,3,3,fur3);

    pixRect(16,6,3,3,fur);
    pixRect(17,7,2,2,fur2);
    pixRect(18,7,1,1,dark);

    if(p.blink>0) pixRect(14,5,2,1,dark);
    else{
      pixRect(14,5,1,1,dark);
      pixRect(15,5,1,1,"rgba(255,255,255,0.08)");
    }
    pixRect(12,4,2,1,shine);

    pixRect(10,10,6,1,"#ef4444");
    pixRect(12,11,2,1,"#f59e0b");

    const legY = 14;
    const leg1 = (frame===0||frame===2)?1:0;
    const leg2 = (frame===1||frame===3)?1:0;
    pixRect(5,legY,2,3,fur3);
    pixRect(7,legY+leg1,2,3,fur3);
    pixRect(11,legY+leg2,2,3,fur3);
    pixRect(13,legY,2,3,fur3);

    pixRect(0,8,3,2,fur3);
    pixRect(0,7+((wag>0)?1:0),2,1,fur2);

    ctx.restore();
  }

  function drawGuard(g, sx, sy){
    const frame = Math.floor(S.time*6) % 2;
    const flip = g.face < 0;
    ctx.save();
    ctx.translate((sx+g.w/2)|0, (sy+g.h/2)|0);
    ctx.scale(flip?-1:1,1);
    ctx.translate((-g.w/2)|0, (-g.h/2)|0);

    pixRect(4,3,10,14,"#111827");
    pixRect(5,4,8,12,"#374151");
    pixRect(5,0,8,5,"#cbd5e1");
    pixRect(6,1,6,3,"#94a3b8");
    pixRect(7,2,4,1,"#0b1220");
    pixRect(5,16,3,4,"#0b1220");
    pixRect(10,16+frame,3,4,"#0b1220");
    pixRect(1,10,3,1,"#0b1220");
    pixRect(12,8,2,2,"#f59e0b");
    ctx.restore();

    const coneLen = 150;
    const cx = sx + g.w/2;
    const cy = sy + 10;
    ctx.save();
    ctx.globalAlpha = 0.10 + g.saw*0.30;
    ctx.fillStyle = g.saw>0 ? "rgba(239,68,68,0.32)" : "rgba(56,189,248,0.22)";
    ctx.beginPath();
    ctx.moveTo(cx,cy);
    const dir = g.face;
    ctx.lineTo(cx + dir*coneLen, cy-42);
    ctx.lineTo(cx + dir*coneLen, cy+42);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawDrone(d, sx, sy){
    pixRect(sx,sy,d.w,d.h,"#4b5563");
    pixRect(sx+2,sy+2,d.w-4,d.h-4,"#0b1220");
    pixRect(sx+4,sy+4,3,3,"#22c55e");
    pixRect(sx+9,sy+4,3,3,"#22c55e");
    if((Math.floor(S.time*4)%2)===0) pixRect(sx+6,sy+1,6,1,"#f59e0b");

    const beam = 96 + Math.sin(d.t*3)*8;
    ctx.save();
    ctx.globalAlpha = 0.10 + d.laser*0.30;
    ctx.fillStyle = d.laser>0 ? "rgba(239,68,68,0.30)" : "rgba(34,197,94,0.20)";
    ctx.beginPath();
    ctx.moveTo(sx+d.w/2, sy+d.h);
    ctx.lineTo(sx-32, sy+d.h+beam);
    ctx.lineTo(sx+d.w+32, sy+d.h+beam);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawSaw(s, sx, sy){
    const t = S.time*6;
    pixRect(sx,sy,18,18,"#0b1220");
    pixRect(sx+1,sy+1,16,16,"#cbd5e1");
    pixRect(sx+4,sy+4,10,10,"#4b5563");
    const tooth = ((Math.floor(t)%4)+4)%4;
    const toothC = "#f8fafc";
    if(tooth===0) pixRect(sx+8,sy,2,3,toothC);
    if(tooth===1) pixRect(sx+15,sy+8,3,2,toothC);
    if(tooth===2) pixRect(sx+8,sy+15,2,3,toothC);
    if(tooth===3) pixRect(sx,sy+8,3,2,toothC);
    ctx.save();
    ctx.globalAlpha = 0.14;
    pixRect(sx-2,sy-2,22,22,"rgba(239,68,68,0.15)");
    ctx.restore();
  }

  function drawChaser(c, sx, sy){
    pixRect(sx,sy,c.w,c.h,"#0b1220");
    pixRect(sx+2,sy+2,c.w-4,c.h-4,"#ef4444");
    pixRect(sx+4,sy+4,3,3,"#0b1220");
    pixRect(sx+11,sy+4,3,3,"#0b1220");
    pixRect(sx+6,sy+10,6,2,"#0b1220");
    ctx.save();
    ctx.globalAlpha = 0.16;
    pixRect(sx-3,sy-3,24,24,"rgba(239,68,68,0.20)");
    ctx.restore();
  }

  function drawDoor(d, sx, sy){
    pixRect(sx,sy,d.w,d.h,"#0b1220");
    if(d.open){
      ctx.save();
      ctx.globalAlpha = 0.35;
      pixRect(sx+2,sy+2,d.w-4,d.h-4,"rgba(34,197,94,0.08)");
      ctx.restore();
      return;
    }
    pixRect(sx+2,sy+2,d.w-4,d.h-4,"#1f2937");
    for(let i=0;i<4;i++){
      pixRect(sx+4+i*5, sy+4, 2, d.h-8, "rgba(148,163,184,0.38)");
      pixRect(sx+4+i*5, sy+4, 1, d.h-8, "rgba(0,0,0,0.18)");
    }
    if(d.locked){
      pixRect(sx+d.w-8, sy+8, 4, 6, "#eab308");
      pixRect(sx+d.w-7, sy+10, 2, 2, "#0b1220");
      if((Math.floor(S.time*6)%6)===0) pixRect(sx+d.w-9, sy+7, 2, 2, "rgba(255,255,255,0.20)");
    }
  }

  function drawPickup(pk, sx, sy){
    pk.t += S.dt;
    const bob = Math.sin(pk.t*4)*2;
    const x = sx, y = sy + bob;

    ctx.save();
    ctx.globalAlpha = 0.18;
    const glowColor = pk.kind==="key" ? "rgba(245,158,11,0.35)"
                    : pk.kind==="bone" ? "rgba(163,230,53,0.30)"
                    : pk.kind==="treat" ? "rgba(251,113,133,0.30)"
                    : "rgba(56,189,248,0.25)";
    pixRect(x-3,y-3,20,20,glowColor);
    ctx.restore();

    if(pk.kind==="key"){
      pixRect(x+2,y+5,10,4,"#eab308");
      pixRect(x+10,y+3,3,3,"#eab308");
      pixRect(x+11,y+4,1,1,"#0b1220");
      pixRect(x+4,y+4,2,1,"rgba(255,255,255,0.25)");
    }else if(pk.kind==="bone"){
      pixRect(x+3,y+6,8,3,"#a3e635");
      pixRect(x+2,y+5,2,2,"#a3e635");
      pixRect(x+10,y+5,2,2,"#a3e635");
      pixRect(x+2,y+8,2,2,"#a3e635");
      pixRect(x+10,y+8,2,2,"#a3e635");
    }else if(pk.kind==="treat"){
      pixRect(x+4,y+5,6,6,"#fb7185");
      pixRect(x+5,y+6,4,4,"rgba(255,255,255,0.14)");
    }else if(pk.kind==="checkpoint"){
      pixRect(x+5,y+2,2,16,"#e2e8f0");
      pixRect(x+7,y+2,8,5,"#f59e0b");
      pixRect(x+7,y+7,8,3,"#d97706");
    }
  }

  function drawHUD(){
    const p = S.player;

    ctx.save();
    ctx.globalAlpha = 0.90;
    pixRect(10,10, 360, 68, "rgba(2,6,23,0.62)");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.strokeRect(10.5,10.5,360,68);

    // hearts
    let x = 18, y = 18;
    for(let i=0;i<p.maxHp;i++){
      const full = i < p.hp;
      const c = full ? "#fb7185" : "rgba(255,255,255,0.18)";
      pixRect(x+2,y+2,4,4,c);
      pixRect(x+8,y+2,4,4,c);
      pixRect(x+2,y+6,10,6,c);
      pixRect(x+4,y+12,6,3,c);
      x += 18;
    }

    pixText(`🦴 ${p.bones}`, 18, 44, 14, "#cbd5e1");
    pixText(`🍪 ${p.treats}`, 108, 44, 14, "#cbd5e1");
    pixText(`🔑 ${p.hasKey ? "1" : "0"}`, 204, 44, 14, "#cbd5e1");

    const barX=268, barY=46, barW=92, barH=10;
    pixRect(barX,barY,barW,barH,"rgba(255,255,255,0.12)");
    const fillW = Math.floor(barW*(S.alert/100));
    pixRect(barX,barY, fillW, barH, S.alert>=70 ? "#ef4444" : "#38bdf8");
    pixText("ALERTA", barX, barY-14, 11, "#cbd5e1");
    ctx.restore();

    const obj = S.L?.objectives?.[p.objectiveStep] || "";
    if(obj){
      ctx.save();
      ctx.globalAlpha = 0.95;
      const w = Math.min(720, 20 + obj.length*7);
      const bx = (BASE_W/2 - w/2)|0;
      pixRect(bx, 12, w, 22, "rgba(2,6,23,0.62)");
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.strokeRect(bx+0.5, 12.5, w, 22);
      pixText(obj, BASE_W/2, 15, 12, "#e5e7eb", "center");
      ctx.restore();
    }

    if(S.msgT>0){
      ctx.save();
      ctx.globalAlpha = clamp(S.msgT/1.2, 0, 1);
      pixRect(10, BASE_H-48, 640, 32, "rgba(2,6,23,0.66)");
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.strokeRect(10.5, BASE_H-47.5, 640, 32);
      pixText(S.msg, 20, BASE_H-42, 13, "#e5e7eb");
      ctx.restore();
    }
  }

  /**********************
   * GAMEPLAY
   **********************/
  function startLevel(index, save=null){
    S.levelIndex = clamp(index,0,LEVELS.length-1);
    S.L = LEVELS[S.levelIndex]();
    S.entities = [];
    S.doors = S.L.doors.map(makeDoor);
    S.pickups = S.L.pickups.map(makePickup);
    S.alert = 0;
    S.alertSpawned = false;
    S.particles = [];
    S.msg = ""; S.msgT = 0;

    const p = S.player = newPlayer();
    p.x = S.L.spawn.x;
    p.y = S.L.spawn.y;
    p.respawnX = p.x;
    p.respawnY = p.y;

    // enemies
    for(const e of S.L.enemies){
      if(e.kind==="guard") S.entities.push(makeGuard(e));
      if(e.kind==="drone") S.entities.push(makeDrone(e));
      if(e.kind==="saw")   S.entities.push(makeSaw(e));
    }

    // apply save
    if(save){
      p.maxHp = save.maxHp ?? p.maxHp;
      p.hp = clamp(save.hp ?? p.hp, 1, p.maxHp);
      p.bones = save.bones ?? 0;
      p.treats = save.treats ?? 0;
      p.hasKey = !!save.hasKey;
      p.objectiveStep = save.objectiveStep ?? 0;
      p.x = save.respawnX ?? p.x;
      p.y = save.respawnY ?? p.y;
      p.respawnX = p.x;
      p.respawnY = p.y;
      S.alert = save.alert ?? 0;
      // marca checkpoint como pego (só visual)
      for(const pk of S.pickups){
        if(pk.kind==="checkpoint"){
          if(Math.abs((pk.x-5) - p.respawnX) < 40) pk.taken = true;
        }
      }
    }

    menuObjective.textContent = `Fase ${S.L.id}: ${S.L.objectives[0]}`;
    setMessage(S.L.objectives[p.objectiveStep] || "Boa sorte!");
  }

  function hurt(amount=1, knockX=220, knockY=-360){
    const p = S.player;
    if(p.inv>0) return;
    p.hp -= amount;
    p.inv = 1.0;
    p.vx = knockX * -p.face;
    p.vy = knockY;
    S.shake = 0.25;
    audio.beep(140,0.08,"square",0.05);
    burst(p.x+p.w/2, p.y+p.h/2, 10, "rgba(251,113,133,0.9)");
    if(p.hp<=0){
      S.mode = "gameover";
      setMode("menu");
      menuSubtitle.textContent =
        "Game Over. Lili levou um susto.\nBora tentar de novo? (Agora com mais caramelo e menos problema.)";
      btnPlay.textContent = "Tentar novamente";
      btnContinue.style.display = "none";
      menuObjective.textContent = "Dica: use E perto das portas e evite cones de visão.";
    }
  }

  function respawn(){
    const p = S.player;
    p.hp = p.maxHp;
    p.vx = 0; p.vy = 0;
    p.x = p.respawnX;
    p.y = p.respawnY;
    S.alert = Math.max(0, S.alert-25);
    S.alertSpawned = false;
    setMessage("Respawn no checkpoint. Lili: “tá tudo sob controle…”");
    burst(p.x+p.w/2, p.y+p.h/2, 14, "rgba(56,189,248,0.7)");
  }

  function addAlert(v){
    S.alert = clamp(S.alert + v, 0, 100);
    if(S.alert>=100 && !S.alertSpawned){
      const p = S.player;
      S.entities.push(makeChaser(p.x - 220, p.y));
      S.alertSpawned = true;
      S.shake = 0.35;
      setMessage("ALERTA MÁXIMO! Perseguição ativada! 😬");
      audio.beep(120,0.10,"square",0.06);
      audio.beep(180,0.10,"square",0.06);
      audio.beep(220,0.10,"square",0.06);
      burst(p.x+p.w/2, p.y+p.h/2, 18, "rgba(239,68,68,0.85)");
    }
  }

  function tryInteract(){
    const p = S.player;
    for(const d of S.doors){
      if(aabb(p.x-6,p.y-6,p.w+12,p.h+12, d.x,d.y,d.w,d.h)){
        if(!d.open){
          if(d.locked){
            if(p.hasKey){
              d.locked = false;
              d.open = true;
              p.hasKey = false;
              audio.beep(880,0.06,"square",0.05);
              audio.beep(660,0.06,"square",0.05);
              setMessage("Clique! Portão aberto!");
              burst(d.x+d.w/2, d.y+d.h/2, 10, "rgba(245,158,11,0.9)");
              if(S.L.id===1 && p.objectiveStep<2){
                p.objectiveStep = 2;
                setMessage(S.L.objectives[p.objectiveStep]);
              }
              saveGame();
              return;
            } else {
              audio.beep(220,0.06,"square",0.05);
              setMessage("Trancado. Precisa de uma chave.");
              return;
            }
          } else {
            d.open = true;
            audio.beep(740,0.05,"square",0.05);
            setMessage("Porta aberta!");
            saveGame();
            return;
          }
        }
      }
    }
  }

  function nextLevel(){
    const next = S.levelIndex + 1;
    if(next >= LEVELS.length){
      S.mode = "win";
      setMode("menu");
      menuSubtitle.textContent =
        "Lili chegou em casa! 🏡🐶\n\nEla pensa: “Alô Lilinha… eu consegui!”\nDepois ela faz pose de vitória e pede petisco.";
      btnPlay.textContent = "Jogar de novo";
      btnContinue.style.display = "none";
      menuObjective.textContent = "Fim!";
      clearSave();
      return;
    }
    startLevel(next, null);
    S.mode = "playing";
    setMode("playing");
    saveGame();
  }

  /**********************
   * UPDATE
   **********************/
  function update(dt){
    S.dt = dt;
    S.time += dt;
    if(!S.L) return;

    if(pressed("p")) togglePause();
    if(S.mode!=="playing") return;

    const L = S.L;
    const p = S.player;

    if(Math.random()<0.012) p.blink = 0.12;
    p.blink = Math.max(0, p.blink - dt);
    S.msgT = Math.max(0, S.msgT - dt);

    const left = down("a") || down("arrowleft") || pad.left;
    const right = down("d") || down("arrowright") || pad.right;
    const jumpPressed = pressed("w") || pressed("arrowup") || pressed(" ") || pressed("space") || pad.jump;
    const jumpHeld = down("w") || down("arrowup") || down(" ") || down("space") || pad.jump;
    const run = down("shift") || pad.run;
    const interact = pressed("e") || pad.interact;

    if(interact) tryInteract();

    p.run = run;
    const speed = run ? 210 : 145;

    if(jumpPressed) p.jumpBuf = 0.13;
    else p.jumpBuf = Math.max(0, p.jumpBuf - dt);

    if(p.onGround) p.coyote = 0.11;
    else p.coyote = Math.max(0, p.coyote - dt);

    let targetVX = 0;
    if(left) targetVX -= speed;
    if(right) targetVX += speed;
    if(targetVX !== 0) p.face = Math.sign(targetVX);
    p.vx = lerp(p.vx, targetVX, 1 - Math.pow(0.0001, dt));

    p.vy = Math.min(MAX_FALL, p.vy + GRAV*dt);

    if(p.jumpBuf>0 && p.coyote>0){
      p.vy = JUMP_V;
      p.jumpBuf = 0;
      p.coyote = 0;
      p.jumpHold = JUMP_HOLD;
      audio.beep(520,0.04,"square",0.04);
      burst(p.x+p.w/2, p.y+p.h, 7, "rgba(245,158,11,0.7)");
    }

    if(jumpHeld && p.jumpHold>0 && p.vy < 0){
      p.vy -= GRAV*dt*0.45;
      p.jumpHold = Math.max(0, p.jumpHold - dt);
    } else {
      p.jumpHold = Math.max(0, p.jumpHold - dt);
    }

    moveAndCollide(p, dt);

    p.animT += dt * (Math.abs(p.vx)>5 ? 1.4 : 0.55);
    p.inv = Math.max(0, p.inv - dt);

    // hazards
    const pts = [
      [p.x+3, p.y+p.h-1],
      [p.x+p.w-3, p.y+p.h-1],
      [p.x+p.w/2, p.y+p.h-1],
      [p.x+p.w/2, p.y+2]
    ];
    for(const [wx,wy] of pts){
      const t = tileAt(wx,wy);
      if(hazard(t)){
        hurt(1, 240, -380);
        setMessage(t===T.SPIKE ? "Ai! Espinho!" : "ZAP! Laser!");
        break;
      }
    }

    // pickups
    for(const pk of S.pickups){
      if(pk.taken) continue;
      if(aabb(p.x,p.y,p.w,p.h, pk.x, pk.y, pk.w, pk.h)){
        pk.taken = true;
        if(pk.kind==="key"){
          p.hasKey = true;
          audio.beep(880,0.05,"square",0.05);
          setMessage("Você pegou uma chave! 🔑");
          burst(pk.x, pk.y, 10, "rgba(245,158,11,0.9)");
          if(p.objectiveStep<1){
            p.objectiveStep = 1;
            setMessage(L.objectives[p.objectiveStep]);
          }
          saveGame();
        } else if(pk.kind==="bone"){
          p.bones++;
          audio.beep(660,0.03,"square",0.03);
          burst(pk.x, pk.y, 8, "rgba(163,230,53,0.75)");
          saveGame();
        } else if(pk.kind==="treat"){
          p.treats++;
          p.hp = Math.min(p.maxHp, p.hp+1);
          audio.beep(740,0.04,"square",0.04);
          setMessage("Petisco! Vida +1 🍪");
          burst(pk.x, pk.y, 10, "rgba(251,113,133,0.75)");
          saveGame();
        } else if(pk.kind==="checkpoint"){
          p.respawnX = pk.x;
          p.respawnY = pk.y;
          setMessage("Checkpoint ativado! ✅");
          audio.beep(520,0.05,"square",0.05);
          burst(pk.x, pk.y, 12, "rgba(56,189,248,0.8)");
          saveGame();
        }
      }
    }

    // enemies
    for(const e of S.entities){
      if(e.kind==="guard"){
        e.cd = Math.max(0, e.cd - dt);
        e.vy = Math.min(MAX_FALL, e.vy + GRAV*dt);
        moveAndCollide(e, dt);

        if(e.x < e.minX){ e.x = e.minX; e.face=1; e.vx=70; }
        if(e.x > e.maxX){ e.x = e.maxX; e.face=-1; e.vx=-70; }
        if(Math.abs(e.vx)<1){
          e.face *= -1;
          e.vx = 70*e.face;
        }

        const coneLen=150;
        const cx=e.x+e.w/2, cy=e.y+10;
        const inFront = (e.face>0) ? (p.x>cx && p.x<cx+coneLen) : (p.x<cx && p.x>cx-coneLen);
        const dy = Math.abs((p.y+p.h/2)-cy);
        const visible = inFront && dy<46;

        if(visible){
          e.saw = clamp(e.saw + dt*2.2, 0, 1);
          addAlert(dt*26);
          if(e.saw>0.7 && e.cd<=0){
            e.cd=1.2;
            setMessage("Guarda: “Ei! Volta aqui, caramelo!”");
            audio.beep(260,0.08,"square",0.05);
            addAlert(10);
          }
        } else {
          e.saw = Math.max(0, e.saw - dt*1.2);
        }

        if(aabb(p.x,p.y,p.w,p.h, e.x,e.y,e.w,e.h)){
          hurt(1, 260, -340);
          setMessage("O guarda te pegou!");
        }
      }
      else if(e.kind==="drone"){
        e.t += dt;
        e.y = e.baseY + Math.sin(e.t*1.5)*10;
        const px = p.x+p.w/2, py=p.y+p.h/2;
        const dx = Math.abs(px - (e.x+e.w/2));
        const dy2 = py - (e.y+e.h);
        const sees = dx<34 && dy2>0 && dy2<110;
        if(sees){
          e.laser = clamp(e.laser + dt*2.2, 0, 1);
          addAlert(dt*16);
        } else {
          e.laser = Math.max(0, e.laser - dt*1.5);
        }
        if(sees && e.laser>0.55 && dx<16 && dy2<90){
          hurt(1, 160, -320);
          setMessage("Drone: “BZZT.”");
        }
      }
      else if(e.kind==="saw"){
        e.t += dt;
        e.x = e.baseX + Math.sin(e.t*1.8)*e.range;
        if(aabb(p.x,p.y,p.w,p.h, e.x,e.y,e.w,e.h)){
          hurt(1, 320, -420);
          setMessage("Serra! Corre!");
        }
      }
      else if(e.kind==="chaser"){
        e.ttl -= dt;
        const dx = (p.x - e.x);
        e.face = dx>=0 ? 1 : -1;
        const speed2 = 170 + (S.alert>60?60:0);
        e.vx = clamp(dx, -1, 1) * speed2;
        e.vy = Math.min(MAX_FALL, e.vy + GRAV*dt);

        if(e.onGround){
          const aheadX = e.face>0 ? e.x+e.w+2 : e.x-2;
          if(solid(tileAt(aheadX, e.y+e.h-2))) e.vy = -440;
        }
        moveAndCollide(e, dt);

        if(aabb(p.x,p.y,p.w,p.h, e.x,e.y,e.w,e.h)){
          hurt(2, 360, -520);
          setMessage("Perseguidor te alcançou!");
        }

        if(e.ttl<=0){
          e._dead = true;
          S.alertSpawned = false;
          S.alert = Math.max(0, S.alert-30);
          setMessage("O perseguidor desistiu. (Ufa.)");
        }
      }
    }
    S.entities = S.entities.filter(e=>!e._dead);

    // decay alert
    S.alert = Math.max(0, S.alert - 7*dt);

    // fall
    if(p.y > L.h*TILE + 200) respawn();

    // exit
    if(aabb(p.x,p.y,p.w,p.h, L.exit.x,L.exit.y,L.exit.w,L.exit.h)){
      if(L.id===1){
        const gate = S.doors.find(d=>d.id==="gate");
        if(gate && !gate.open){
          setMessage("Ainda não! Abra o portão antes.");
        } else {
          setMessage("Fase concluída! Lili: “tchau, prisão!”");
          audio.beep(880,0.06,"square",0.06);
          saveGame();
          nextLevel();
        }
      } else if(L.id===3){
        setMessage("Casa doce casa! 🏡");
        audio.beep(880,0.06,"square",0.06);
        nextLevel();
      } else {
        setMessage("Fase concluída!");
        audio.beep(880,0.06,"square",0.06);
        saveGame();
        nextLevel();
      }
    }

    // objetivo por progressão
    if(L.id===2 && p.objectiveStep<1 && p.x > 50*TILE){ p.objectiveStep=1; setMessage(L.objectives[1]); saveGame(); }
    if(L.id===2 && p.objectiveStep<2 && p.x > 95*TILE){ p.objectiveStep=2; setMessage(L.objectives[2]); saveGame(); }
    if(L.id===3 && p.objectiveStep<1 && p.x > 60*TILE){ p.objectiveStep=1; setMessage(L.objectives[1]); saveGame(); }
    if(L.id===3 && p.objectiveStep<2 && p.x > 105*TILE){ p.objectiveStep=2; setMessage(L.objectives[2]); saveGame(); }

    updateParticles(dt);

    // camera
    const targetCamX = clamp(p.x - BASE_W*0.45, 0, L.w*TILE - BASE_W);
    const targetCamY = clamp(p.y - BASE_H*0.55, 0, L.h*TILE - BASE_H);
    S.camX = lerp(S.camX, targetCamX, 1 - Math.pow(0.0001, dt));
    S.camY = lerp(S.camY, targetCamY, 1 - Math.pow(0.0001, dt));
    S.shake = Math.max(0, S.shake - dt);
  }

  /**********************
   * RENDER
   **********************/
  function render(){
    if(!S.L){
      ctx.fillStyle="#05070f"; ctx.fillRect(0,0,BASE_W,BASE_H);
      pixText("Alô Lilinha", BASE_W/2, BASE_H/2-10, 22, "#e5e7eb", "center");
      pixText("Clique em Jogar", BASE_W/2, BASE_H/2+18, 14, "#94a3b8", "center");
      return;
    }

    const L = S.L;
    const shake = S.shake>0 ? (Math.sin(S.time*60)*6*S.shake) : 0;
    const camX = (S.camX + shake)|0;
    const camY = (S.camY + shake*0.6)|0;

    drawBackground(L.theme, camX);

    const x0 = Math.floor(camX / TILE) - 2;
    const y0 = Math.floor(camY / TILE) - 2;
    const x1 = x0 + Math.ceil(BASE_W / TILE) + 4;
    const y1 = y0 + Math.ceil(BASE_H / TILE) + 4;

    // tiles
    for(let ty=y0; ty<=y1; ty++){
      for(let tx=x0; tx<=x1; tx++){
        const id = L.get(tx,ty);
        if(id===T.EMPTY) continue;
        drawTile(id, tx*TILE - camX, ty*TILE - camY, tx, ty);
      }
    }

    // exit marker
    ctx.save();
    ctx.globalAlpha = 0.10;
    pixRect(L.exit.x-camX, L.exit.y-camY, L.exit.w, L.exit.h, "#22c55e");
    ctx.restore();

    // pickups
    for(const pk of S.pickups){
      if(pk.taken) continue;
      drawPickup(pk, pk.x-camX, pk.y-camY);
    }

    // doors
    for(const d of S.doors){
      drawDoor(d, d.x-camX, d.y-camY);
    }

    // enemies
    for(const e of S.entities){
      const sx = e.x - camX;
      const sy = e.y - camY;
      if(e.kind==="guard") drawGuard(e, sx, sy);
      else if(e.kind==="drone") drawDrone(e, sx, sy);
      else if(e.kind==="saw") drawSaw(e, sx, sy);
      else if(e.kind==="chaser") drawChaser(e, sx, sy);
    }

    drawParticles(camX, camY);

    // player
    const p = S.player;
    if(!(p.inv>0 && (Math.floor(S.time*18)%2===0))){
      drawLili(p, p.x-camX, p.y-camY);
    }

    vignette(0.52);
    drawHUD();
  }

  /**********************
   * UI BUTTONS
   **********************/
  btnPlay.addEventListener("click", () => {
    audio.beep(660,0.05,"square",0.05);

    if(S.mode==="paused"){
      S.mode="playing";
      setMode("playing");
      btnContinue.style.display = "";
      btnPlay.textContent = "Jogar";
      menuSubtitle.textContent =
        "Lili está fugindo da prisão pra voltar pra casa. Pegue a chave, abra o portão e fuja sem disparar o alarme!";
      return;
    }

    if(S.mode==="gameover" || S.mode==="win"){
      btnContinue.style.display = "";
      btnPlay.textContent = "Jogar";
      menuSubtitle.textContent =
        "Lili está fugindo da prisão pra voltar pra casa. Pegue a chave, abra o portão e fuja sem disparar o alarme!";
      startLevel(0, null);
      S.mode="playing";
      setMode("playing");
      saveGame();
      return;
    }

    startLevel(0, null);
    S.mode="playing";
    setMode("playing");
    saveGame();
  });

  btnContinue.addEventListener("click", () => {
    audio.beep(660,0.05,"square",0.05);
    const s = loadGame();
    if(!s){ showHint("Sem progresso salvo."); return; }
    startLevel(s.levelIndex ?? 0, s);
    S.mode="playing";
    setMode("playing");
  });

  btnReset.addEventListener("click", () => {
    audio.beep(220,0.06,"square",0.05);
    clearSave();
    showHint("Progresso apagado.");
  });

  /**********************
   * LOOP
   **********************/
  let last = performance.now();
  function loop(now){
    const raw = (now-last)/1000;
    last = now;
    const dt = clamp(raw, 0, 0.033);

    if(S.L && S.mode!=="paused" && S.mode!=="menu"){
      update(dt);
    } else {
      S.time += dt;
      S.dt = dt;
      if(S.L) updateParticles(dt*0.15);
    }

    render();
    clearPressed();
    requestAnimationFrame(loop);
  }

  canvas.addEventListener("pointerdown", ()=> { audio.beep(0,0,"square",0); });

  window.addEventListener("keydown", (e)=> {
    if(e.key==="Enter" && S.mode==="menu") btnPlay.click();
  });

  /**********************
   * BOOT
   **********************/
  setMode("menu");
  const s0 = loadGame();
  if(s0){
    startLevel(s0.levelIndex ?? 0, s0);
    S.mode="menu";
    setMode("menu");
  } else {
    startLevel(0, null);
    S.mode="menu";
    setMode("menu");
  }

  setTimeout(()=> showHint("Dica: perto de portas, aperte E", 1800), 700);
  requestAnimationFrame(loop);

})();
