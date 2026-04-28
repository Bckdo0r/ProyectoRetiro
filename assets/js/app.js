// ── STATE ──
let rooms=[], people=[], retiro={total:0,menor:0};
let nRId=1, nPId=1, _eRoomId=null, _addSector='CG', _vPId=null;
let authToken=sessionStorage.getItem('retiro-auth-token')||'';
let savePending=false;
let isBootstrapping=true;
const SAVE_STATUS={
  clean:'Sin cambios pendientes',
  pending:'Cambios pendientes (guardado automático activo)',
  saving:'Guardando cambios…',
  saved:'Cambios guardados automáticamente',
  error:'No se pudo guardar. Reintentando automáticamente…'
};
const AUTOSAVE_INTERVAL_MS=15000;

function setSaveStatus(type){
  const el=document.getElementById('save-status');
  if(!el) return;
  el.textContent=SAVE_STATUS[type]||SAVE_STATUS.clean;
}

function getStatePayload(){
  return {rooms,people,retiro,nRId,nPId};
}

function hydrateState(state){
  if(!state) return;
  rooms=Array.isArray(state.rooms)?state.rooms:rooms;
  people=Array.isArray(state.people)?state.people:[];
  retiro=state.retiro&&typeof state.retiro==='object'?state.retiro:{total:0,menor:0};
  nRId=Number(state.nRId||1);
  nPId=Number(state.nPId||1);
}

async function apiFetch(path, options={}){
  const headers={'Content-Type':'application/json', ...(options.headers||{})};
  if(authToken) headers.Authorization='Bearer '+authToken;
  const res=await fetch(path,{...options,headers});
  if(!res.ok){
    const body=await res.json().catch(()=>({message:'Error inesperado'}));
    throw new Error(body.message||'Error de servidor');
  }
  return res.status===204?null:res.json();
}

async function login(){
  const username=document.getElementById('login-user').value.trim();
  const password=document.getElementById('login-pass').value;
  const msg=document.getElementById('login-msg');
  if(!username||!password){
    msg.textContent='Completá usuario y contraseña.';
    msg.style.color='var(--red)';
    return;
  }
  try{
    msg.textContent='Validando credenciales…';
    msg.style.color='var(--muted)';
    const data=await apiFetch('/api/login',{method:'POST',body:JSON.stringify({username,password})});
    authToken=data.token||'';
    sessionStorage.setItem('retiro-auth-token',authToken);
    document.getElementById('m-login').classList.remove('active');
    await loadServerState();
    isBootstrapping=true;
    render();
    isBootstrapping=false;
    setSaveStatus('clean');
  }catch(err){
    msg.textContent=err.message||'No se pudo iniciar sesión.';
    msg.style.color='var(--red)';
  }
}

async function loadServerState(){
  const data=await apiFetch('/api/state');
  hydrateState(data);
}

function queueAutosave(){
  if(isBootstrapping) return;
  savePending=true;
  setSaveStatus('pending');
}

async function persistState(force=false){
  if((!savePending&&!force)||!authToken||isBootstrapping) return;
  try{
    setSaveStatus('saving');
    await apiFetch('/api/state',{method:'PUT',body:JSON.stringify(getStatePayload())});
    savePending=false;
    setSaveStatus('saved');
    setTimeout(()=>{ if(!savePending) setSaveStatus('clean'); },1500);
  }catch(_){
    setSaveStatus('error');
  }
}

// ── HELPERS ──
const fmt=n=>Number(n||0).toLocaleString('es-AR');
const ini=s=>(s||'').split(' ').map(w=>w[0]).filter(Boolean).slice(0,2).join('').toUpperCase()||'?';
function calcDeuda(p){
  const base=p.pago==='menor'?retiro.menor:retiro.total;
  if(p.pago==='pagado'||p.pago==='becado') return 0;
  if(p.pago==='pendiente'||p.pago==='menor') return base;
  if(p.pago==='seña') return Math.max(0,retiro.total-Number(p.señaM||0));
  return 0;
}
function pagoLabel(p){
  const map={pagado:'pagado',pendiente:'pendiente',seña:'seña',becado:'becado',menor:'menor'};
  const text={pagado:'Pagado',pendiente:'Pendiente',seña:'Seña',becado:'Becado 100%',menor:'Precio menor'};
  return `<span class="pbadge ${map[p.pago]||''}">${text[p.pago]||p.pago}</span>`;
}
function grupoHTML(p){
  if(!p.grupo) return '—';
  return p.grupo+(p.gnum?' <span class="grupo-tag">#'+p.gnum+'</span>':'');
}
function pagoText(p){
  return {pagado:'Pagado',pendiente:'Pendiente',seña:'Seña',becado:'Becado 100%',menor:'Precio menor (13-17)'}[p.pago]||p.pago;
}

// ── DIAGRAM LAYOUTS ──
const DIAGRAM_LAYOUTS={
  baja:{
    cellSize:'68px',
    grid:[
      ['r14','r15','hall','r16','r17','r18','r19','r20','hall2','r21','r22','r23'],
      ['r24','r25','hall','hall','hall','hall','hall','hall','hall2','r26','r27','r28'],
      ['r29','r30','hall','hall','hall','hall','hall','hall','hall2','r31','r32','r33'],
      ['r34','r34','hall','hall','hall','hall','hall','hall','hall2','hall2','hall2','hall2'],
      ['.','.','hall','hall','hall','hall','hall','hall','hall2','.','.','.'],
      ['extras','extras','extras','extras','extras','extras','extras','extras','extras','extras','extras','extras']
    ],
    labelPrefix:'Habitación'
  },
  alta:{
    cellSize:'70px',
    grid:[
      ['r1','r2','r3','r4','r5','hall','r6','r7','r8','r9','r10'],
      ['.','.','.','.','.','hall','.','.','.','.','.'],
      ['r11','r12','r13','.','.','hall','.','.','.','.','.'],
      ['.','.','.','.','.','hall','.','.','.','.','.'],
      ['extras','extras','extras','extras','extras','extras','extras','extras','extras','extras','extras']
    ],
    labelPrefix:'Habitación'
  },
  ch:{
    cellSize:'78px',
    grid:[
      ['r1','r1','hall','r2','r2','.'],
      ['r1','r1','hall','r2','r2','.'],
      ['r3','r3','hall','r4','r4','.'],
      ['extras','extras','extras','extras','extras','extras']
    ],
    labelPrefix:'Chalecito'
  }
};
const DIAGRAM_ZOOM_DELTA=0.08;
const DIAGRAM_ZOOM_MIN=0.7;
const DIAGRAM_ZOOM_MAX=1.6;
const diagramStates=new Map();
function getRoomNumber(name){
  const m=String(name||'').match(/(\d+)(?!.*\d)/);
  return m?Number(m[0]):null;
}
function getRoomLabel(name, fallback){
  const base=name||fallback||'Habitación';
  return base.replace('Habitación','Hab.').trim();
}
function getRoomOccupants(r){
  return (r.personas||[]).map(pid=>people.find(p=>p.id===pid)).filter(Boolean);
}
function applyDiagramTransform(map, state){
  map.style.setProperty('--map-x',state.x+'px');
  map.style.setProperty('--map-y',state.y+'px');
  map.style.setProperty('--map-scale',state.scale);
}
function setupDiagramViewport(viewport){
  const map=viewport.querySelector('.diagram-map');
  if(!map||diagramStates.has(map)) return;
  const state={x:0,y:0,scale:1,dragging:false,startX:0,startY:0,originX:0,originY:0};
  diagramStates.set(map,state);
  applyDiagramTransform(map,state);
  viewport.addEventListener('pointerdown',e=>{
    if(e.target.closest('.diagram-room')||e.target.closest('.diagram-extras')) return;
    viewport.setPointerCapture(e.pointerId);
    state.dragging=true;
    state.startX=e.clientX;
    state.startY=e.clientY;
    state.originX=state.x;
    state.originY=state.y;
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove',e=>{
    if(!state.dragging) return;
    state.x=state.originX+(e.clientX-state.startX);
    state.y=state.originY+(e.clientY-state.startY);
    applyDiagramTransform(map,state);
  });
  viewport.addEventListener('pointerup',()=>{
    state.dragging=false;
    viewport.classList.remove('dragging');
  });
  viewport.addEventListener('pointercancel',()=>{
    state.dragging=false;
    viewport.classList.remove('dragging');
  });
  viewport.addEventListener('wheel',e=>{
    if(!(e.ctrlKey||e.metaKey)) return;
    e.preventDefault();
    const delta=e.deltaY>0?-DIAGRAM_ZOOM_DELTA:DIAGRAM_ZOOM_DELTA;
    state.scale=Math.min(DIAGRAM_ZOOM_MAX,Math.max(DIAGRAM_ZOOM_MIN,state.scale+delta));
    applyDiagramTransform(map,state);
  },{passive:false});
}
function initDiagramViewports(){
  document.querySelectorAll('.diagram-viewport').forEach(setupDiagramViewport);
}
function resetDiagramView(mapId){
  const map=document.getElementById(mapId);
  if(!map) return;
  const state=diagramStates.get(map);
  if(!state) return;
  state.x=0;state.y=0;state.scale=1;
  applyDiagramTransform(map,state);
}
function buildDiagramRoom(area, number, room, labelPrefix){
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='diagram-room';
  btn.style.gridArea=area;
  const fallback=`${labelPrefix||'Habitación'} ${number}`;
  const name=getRoomLabel(room?room.nombre:null,fallback);
  const occ=room?getRoomOccupants(room):[];
  const cap=room?room.capacidad:0;
  if(!room) btn.classList.add('missing');
  if(room&&cap>0&&occ.length>=cap) btn.classList.add('full');
  const tipText=room
    ?(occ.length?occ.map(p=>p.nombre).join(' · '):'Sin ocupantes')
    :'Habitación sin configurar';
  btn.innerHTML=`<span class="diagram-room-name">${name}</span><span class="diagram-room-cap">${room?`${occ.length}/${cap}`:'—'}</span><span class="diagram-room-tip">${tipText}</span>`;
  if(room){
    btn.onclick=()=>openAssignFromRoom(room.id);
    btn.setAttribute('aria-label',`${name} (${occ.length}/${cap})`);
  }else{
    btn.setAttribute('aria-label',name);
  }
  return btn;
}
function buildDiagramHall(area, variant){
  const hall=document.createElement('div');
  hall.className='diagram-hall'+(variant?' '+variant:'');
  hall.style.gridArea=area;
  return hall;
}
function buildDiagramExtras(area, list, layoutRooms){
  const wrap=document.createElement('div');
  wrap.className='diagram-extras';
  wrap.style.gridArea=area;
  const title=document.createElement('div');
  title.className='diagram-extras-title';
  title.textContent='Habitaciones fuera del plano';
  const listEl=document.createElement('div');
  listEl.className='diagram-extras-list';
  const extras=list.filter(r=>{
    const num=getRoomNumber(r.nombre);
    return !num||!layoutRooms.has(num);
  });
  if(extras.length===0){
    const empty=document.createElement('div');
    empty.className='diagram-hint';
    empty.textContent='Sin habitaciones extra.';
    listEl.appendChild(empty);
  }else{
    extras.forEach(r=>{
      const btn=document.createElement('button');
      btn.type='button';
      btn.className='diagram-extra-room';
      btn.textContent=r.nombre;
      btn.onclick=()=>openAssignFromRoom(r.id);
      listEl.appendChild(btn);
    });
  }
  wrap.appendChild(title);
  wrap.appendChild(listEl);
  return wrap;
}
function renderDiagramMap(mapId, layout, list){
  const map=document.getElementById(mapId);
  if(!map||!layout||!layout.grid) return;
  const grid=layout.grid;
  map.style.setProperty('--map-cols',grid[0].length);
  map.style.setProperty('--map-rows',grid.length);
  map.style.setProperty('--cell-size',layout.cellSize||'70px');
  map.style.gridTemplateAreas=grid.map(row=>`"${row.join(' ')}"`).join(' ');
  map.innerHTML='';
  const roomNumbers=new Set();
  grid.flat().forEach(token=>{
    if(token.startsWith('r')) roomNumbers.add(Number(token.slice(1)));
  });
  const roomsByNumber=new Map();
  list.forEach(r=>{
    const num=getRoomNumber(r.nombre);
    if(num) roomsByNumber.set(num,r);
  });
  const used=new Set();
  grid.flat().forEach(token=>{
    if(token==='.'||used.has(token)) return;
    used.add(token);
    if(token.startsWith('r')){
      const num=Number(token.slice(1));
      map.appendChild(buildDiagramRoom(token,num,roomsByNumber.get(num),layout.labelPrefix));
      return;
    }
    if(token==='extras'){
      map.appendChild(buildDiagramExtras(token,list,roomNumbers));
      return;
    }
    const variant=token.includes('2')?'secondary':'';
    map.appendChild(buildDiagramHall(token,variant));
  });
}

// ── NAV ──
function showPage(id){
  const pageId=['diagrama','gestion','lista'].includes(id)?id:'gestion';
  document.querySelectorAll('.page').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.nav-tab[data-page]').forEach(el=>el.classList.remove('active'));
  const page=document.getElementById('page-'+pageId);
  if(page) page.classList.add('active');
  const tab=document.querySelector(`.nav-tab[data-page="${pageId}"]`);
  if(tab) tab.classList.add('active');
  if(pageId==='lista') renderLista();
  if(pageId==='diagrama') renderDiagrama();
}

// ── PAGO CHANGE ──
function onPagoChange(pfx){
  const v=document.getElementById(pfx+'-pago').value;
  const seEl=document.getElementById(pfx+'-seña-x');
  if(seEl) seEl.classList.toggle('show',v==='seña');
}

// ── ADD PERSON ──
function getAgeCategory(edad){
  const e=parseInt(edad);
  if(!e||isNaN(e)) return null;
  if(e<=12) return 'becado';
  if(e<=17) return 'menor';
  return null;
}
function onEdadChange(){
  const edad=document.getElementById('f-edad').value;
  const cat=getAgeCategory(edad);
  const hint=document.getElementById('f-age-hint');
  const pagoSel=document.getElementById('f-pago');
  if(cat==='becado'){
    pagoSel.value='becado';
    hint.style.display='block';
    hint.style.background='#f0e8f5'; hint.style.color='#6a3a7a';
    hint.textContent='★ Menor de 12 años — becado automáticamente al 100%';
    document.getElementById('f-seña-x').classList.remove('show');
  } else if(cat==='menor'){
    pagoSel.value='menor';
    hint.style.display='block';
    hint.style.background='#e8f4f0'; hint.style.color='#2a6b5a';
    hint.textContent='★ Entre 13 y 17 años — se aplica precio especial de menores';
    document.getElementById('f-seña-x').classList.remove('show');
  } else {
    pagoSel.value='pendiente';
    hint.style.display='none';
    document.getElementById('f-seña-x').classList.remove('show');
  }
}
function nextGrupoNum(grupo){
  if(!grupo) return '';
  const nums=people.filter(p=>p.grupo&&p.grupo.toLowerCase()===grupo.toLowerCase()&&p.gnum).map(p=>Number(p.gnum));
  if(nums.length===0) return '1';
  return String(Math.max(...nums)+1);
}
function addPerson(wait){
  const nombre=document.getElementById('f-nombre').value.trim();
  if(!nombre){alert('El nombre es obligatorio.');return;}
  const pago=document.getElementById('f-pago').value;
  const grupo=document.getElementById('f-grupo').value.trim();
  const gnum=grupo?nextGrupoNum(grupo):'';
  people.push({
    id:nPId++, nombre,
    edad:document.getElementById('f-edad').value||'-',
    ciudad:document.getElementById('f-ciudad').value.trim()||'-',
    tel:document.getElementById('f-tel').value.trim()||'',
    grupo, gnum,
    comida:document.getElementById('f-comida').value,
    nota:document.getElementById('f-nota').value.trim()||'',
    pago,
    señaM:pago==='seña'?Number(document.getElementById('f-señaM').value||0):0,
    roomId:null, waitlist:!!wait
  });
  ['f-nombre','f-edad','f-ciudad','f-tel','f-grupo','f-señaM','f-nota'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('f-comida').value='normal';
  document.getElementById('f-pago').value='pendiente';
  document.getElementById('f-seña-x').classList.remove('show');
  document.getElementById('f-age-hint').style.display='none';
  render();
}

// ── ROOMS ──
function openAddRoomModal(sector){
  _addSector=sector;
  document.getElementById('mr-n').value='';
  document.getElementById('mr-c').value='4';
  document.getElementById('mr-sub-wrap').style.display=sector==='CG'?'flex':'none';
  openModal('m-addRoom');
}
function confirmAddRoom(){
  const n=document.getElementById('mr-n').value.trim();
  const c=parseInt(document.getElementById('mr-c').value);
  if(!n){alert('Nombre requerido.');return;}
  if(!c||c<1){alert('Capacidad inválida.');return;}
  const sub=_addSector==='CG'?document.getElementById('mr-sub').value:null;
  rooms.push({id:nRId++,nombre:n,sector:_addSector,subsector:sub,capacidad:c,personas:[]});
  closeModal('m-addRoom');render();
}
function openEditRoom(rId){
  const r=rooms.find(x=>x.id===rId);if(!r)return;
  _eRoomId=rId;
  document.getElementById('er-n').value=r.nombre;
  document.getElementById('er-c').value=r.capacidad;
  openModal('m-editRoom');
}
function confirmEditRoom(){
  const r=rooms.find(x=>x.id===_eRoomId);if(!r)return;
  const n=document.getElementById('er-n').value.trim();
  const c=parseInt(document.getElementById('er-c').value);
  if(!n){alert('Nombre requerido.');return;}
  if(!c||c<r.personas.length){alert(`Capacidad mínima: ${r.personas.length} (ocupantes actuales).`);return;}
  r.nombre=n;r.capacidad=c;
  closeModal('m-editRoom');render();
}
function deleteRoom(rId){
  const r=rooms.find(x=>x.id===rId);if(!r)return;
  openConfirm('Eliminar habitación', 'Eliminar la habitación "'+r.nombre+'" y mover sus ocupantes a sin habitación?', function(){
    r.personas.forEach(pid=>{const p=people.find(x=>x.id===pid);if(p)p.roomId=null;});
    rooms=rooms.filter(x=>x.id!==rId);render();
  });
}

// ── ASSIGN ──
function removePerson(pId,rId){
  const p=people.find(x=>x.id===pId),r=rooms.find(x=>x.id===rId);
  if(p)p.roomId=null;
  if(r)r.personas=r.personas.filter(x=>x!==pId);
  render();
}
function buildAssignRoomList(pId){
  const avail=rooms.filter(r=>r.personas.length<r.capacidad);
  return avail.length===0
    ? '<div class="empty"><p>No hay habitaciones disponibles.</p></div>'
    : avail.map(r=>`<div class="assign-item" onclick="assignTo(${pId},${r.id})">
        <div class="avatar" style="width:28px;height:28px;font-size:0.73rem">${r.nombre[0]}</div>
        <div><div style="font-size:0.81rem;font-weight:500">${r.nombre}</div>
        <div style="font-size:0.68rem;color:var(--muted)">${r.sector==='CG'?'Casa Grande':'Chalecito'} · ${r.personas.length}/${r.capacidad}</div></div>
      </div>`).join('');
}
function buildAssignPersonList(rId){
  const avail=people.filter(x=>!x.roomId&&!x.waitlist);
  return avail.length===0
    ? '<div class="empty"><p>No hay personas sin habitación.</p></div>'
    : avail.map(p=>`<div class="assign-item" onclick="assignTo(${p.id},${rId})">
        <div class="avatar" style="width:28px;height:28px;font-size:0.73rem">${ini(p.nombre)}</div>
        <div><div style="font-size:0.81rem;font-weight:500">${p.nombre}</div>
        <div style="font-size:0.68rem;color:var(--muted)">${p.edad} a. · ${p.ciudad}</div></div>
        ${pagoLabel(p)}
      </div>`).join('');
}
function openAssignModal(pId){
  const p=people.find(x=>x.id===pId);if(!p)return;
  document.getElementById('ma-t').textContent='Asignar habitación';
  document.getElementById('ma-s').textContent='Seleccioná una habitación para '+p.nombre;
  document.getElementById('ma-list').innerHTML=buildAssignRoomList(pId);
  openModal('m-assign');
}
function openAssignFromRoom(rId){
  const r=rooms.find(x=>x.id===rId);if(!r)return;
  document.getElementById('ma-t').textContent='Asignar a '+r.nombre;
  document.getElementById('ma-s').textContent='Seleccioná quién entrará en esta habitación';
  document.getElementById('ma-list').innerHTML=buildAssignPersonList(rId);
  openModal('m-assign');
}
function openAssignFromWait(pId){
  const p=people.find(x=>x.id===pId);if(!p)return;
  document.getElementById('ma-t').textContent='Mover de lista de espera';
  document.getElementById('ma-s').textContent='Asignar habitación para '+p.nombre;
  document.getElementById('ma-list').innerHTML=buildAssignRoomList(pId);
  openModal('m-assign');
}
function assignTo(pId,rId){
  const p=people.find(x=>x.id===pId),r=rooms.find(x=>x.id===rId);
  if(!p||!r)return;
  if(r.personas.length>=r.capacidad){alert('Habitación llena.');return;}
  if(p.roomId){const prev=rooms.find(x=>x.id===p.roomId);if(prev)prev.personas=prev.personas.filter(x=>x!==pId);}
  p.roomId=rId;p.waitlist=false;
  if(!r.personas.includes(pId))r.personas.push(pId);
  closeModal('m-assign');render();
}
function removeFromWait(pId){
  const p=people.find(x=>x.id===pId);if(!p)return;
  openConfirm('Eliminar persona','Quitar a '+p.nombre+' de la lista de espera?',function(){
    people=people.filter(x=>x.id!==pId);render();
  });
}

// ── PERSON DETAIL ──
function openPersonModal(pId){
  const p=people.find(x=>x.id===pId);if(!p)return;
  _vPId=pId;
  document.getElementById('pd-n').textContent=p.nombre;
  const hab=p.roomId?(rooms.find(x=>x.id===p.roomId)||{nombre:'—'}).nombre:(p.waitlist?'En lista de espera':'Sin asignar');
  const deuda=calcDeuda(p);
  document.getElementById('pd-g').innerHTML=`
    <div class="ditem"><div class="dlabel">Edad</div><div class="dval">${p.edad} años</div></div>
    <div class="ditem"><div class="dlabel">Ciudad</div><div class="dval">${p.ciudad}</div></div>
    <div class="ditem"><div class="dlabel">Teléfono</div><div class="dval">${p.tel||'—'}</div></div>
    <div class="ditem"><div class="dlabel">Grupo familiar</div><div class="dval">${grupoHTML(p)}</div></div>
    <div class="ditem"><div class="dlabel">Habitación</div><div class="dval">${hab}</div></div>
    <div class="ditem"><div class="dlabel">Deuda</div><div class="dval ${deuda>0?'deuda-cell':''}">${deuda>0?'$'+fmt(deuda):'—'}</div></div>
    <div class="ditem"><div class="dlabel">Menú</div><div class="dval">${p.comida==='vegetariano'?'🥦 Vegetariano':'🍽 Normal'}</div></div>
    ${p.nota?'<div class="ditem" style="grid-column:1/-1"><div class="dlabel">Nota</div><div class="dval" style="color:var(--brown);font-style:italic">'+p.nota+'</div></div>':''}
  `;
  document.getElementById('pd-pago').value=p.pago;
  document.getElementById('pd-señaM').value=p.señaM||'';
  document.getElementById('pd-seña-x').classList.toggle('show',p.pago==='seña');
  document.getElementById('pd-comida').value=p.comida||'normal';
  document.getElementById('pd-nota').value=p.nota||'';
  openModal('m-person');
}
function updatePago(){
  const p=people.find(x=>x.id===_vPId);if(!p)return;
  p.pago=document.getElementById('pd-pago').value;
  p.señaM=Number(document.getElementById('pd-señaM').value||0);
  p.comida=document.getElementById('pd-comida').value;
  p.nota=document.getElementById('pd-nota').value.trim();
  closeModal('m-person');render();
}
function deletePerson(){
  const p=people.find(x=>x.id===_vPId);if(!p)return;
  openConfirm('Eliminar persona','Eliminar a '+p.nombre+'?',function(){
    if(p.roomId){const r=rooms.find(x=>x.id===p.roomId);if(r)r.personas=r.personas.filter(x=>x!==p.id);}
    people=people.filter(x=>x.id!==_vPId);
    closeModal('m-person');render();
  });
}

// ── PRICE ──
function openPriceModal(){
  document.getElementById('mp-t').value=retiro.total||'';
  document.getElementById('mp-m').value=retiro.menor||'';
  openModal('m-price');
}
function confirmPrice(){
  retiro.total=Number(document.getElementById('mp-t').value||0);
  retiro.menor=Number(document.getElementById('mp-m').value||0);
  closeModal('m-price');render();
}

// ── MODALS ──
function openModal(id){document.getElementById(id).classList.add('active');}
function closeModal(id){document.getElementById(id).classList.remove('active');}
document.querySelectorAll('.overlay').forEach(el=>el.addEventListener('click',e=>{
  if(e.target===el&&el.id!=='m-login')el.classList.remove('active');
}));

// ── PRINT ──
function doPrint(){
  document.getElementById('print-date').textContent='Casa de Retiro — Lista General · '+new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'long',year:'numeric'});
  window.print();
}

// ── RENDER ──
function render(){
  const anotados=people.filter(x=>!x.waitlist);
  const enEspera=people.filter(x=>x.waitlist);
  const sinHab=anotados.filter(x=>!x.roomId);
  const conHab=anotados.filter(x=>x.roomId);
  const totalCap=rooms.reduce((s,r)=>s+r.capacidad,0);
  const libres=Math.max(0,totalCap-conHab.length);

  document.getElementById('s-p').textContent=anotados.length;
  document.getElementById('s-c').textContent=totalCap;
  document.getElementById('s-l').textContent=libres;
  document.getElementById('s-sh').textContent=sinHab.length;
  document.getElementById('s-e').textContent=enEspera.length;
  document.getElementById('cnt-sh').textContent=sinHab.length+' persona'+(sinHab.length!==1?'s':'');
  document.getElementById('cnt-wait').textContent=enEspera.length+' persona'+(enEspera.length!==1?'s':'');

  document.getElementById('pv-total').textContent=fmt(retiro.total);
  document.getElementById('pv-menor').textContent=fmt(retiro.menor);

  renderRooms('CG');
  renderRooms('CH');
  renderDiagrama();

  // sin hab
  const shEl=document.getElementById('list-sinHab');
  shEl.innerHTML=sinHab.length===0
    ? '<div class="empty"><div class="ei">✓</div><p>Todos tienen habitación asignada</p></div>'
    : sinHab.map(p=>`<div class="person-item">
        <div class="avatar">${ini(p.nombre)}</div>
        <div class="pinfo"><div class="pname">${p.nombre}</div><div class="psub">${p.edad} a. · ${p.ciudad}${p.comida==='vegetariano'?' · 🥦':''}</div></div>
        ${pagoLabel(p)}
        <div class="pactions">
          <button class="icon-btn" onclick="openAssignModal(${p.id})" title="Asignar">🏠</button>
          <button class="icon-btn" onclick="openPersonModal(${p.id})" title="Ver">👁</button>
        </div>
      </div>`).join('');

  // waitlist
  const wEl=document.getElementById('list-wait');
  wEl.innerHTML=enEspera.length===0
    ? '<div class="empty"><div class="ei">—</div><p>Lista de espera vacía</p></div>'
    : enEspera.map(p=>`<div class="person-item">
        <div class="avatar wait">${ini(p.nombre)}</div>
        <div class="pinfo"><div class="pname">${p.nombre}</div><div class="psub">${p.edad} a. · ${p.ciudad}${p.comida==='vegetariano'?' · 🥦':''}</div></div>
        ${pagoLabel(p)}
        <div class="pactions">
          <button class="icon-btn" onclick="openAssignFromWait(${p.id})" title="Asignar hab.">🏠</button>
          <button class="icon-btn" onclick="openPersonModal(${p.id})" title="Ver">👁</button>
          <button class="icon-btn" style="color:var(--red)" onclick="removeFromWait(${p.id})" title="Eliminar">✕</button>
        </div>
      </div>`).join('');
  queueAutosave();
}

// ── COLLAPSIBLE STATE ──
const sectionState={cg:true,ch:true,'cg-alta':true,'cg-vip':true,'cg-baja':true};
function toggleSection(id){
  sectionState[id]=!sectionState[id];
  const body=document.getElementById('section-'+id);
  const arrow=document.getElementById('arrow-'+id);
  body.classList.toggle('collapsed',!sectionState[id]);
  arrow.classList.toggle('collapsed',!sectionState[id]);
}
function toggleSubsector(id){
  sectionState[id]=!sectionState[id];
  const grid=document.getElementById('grid-'+id);
  const arrow=document.getElementById('arrow-'+id);
  grid.classList.toggle('collapsed',!sectionState[id]);
  arrow.classList.toggle('collapsed',!sectionState[id]);
}

function roomCardHTML(r){
  const occ=r.personas.map(pid=>people.find(x=>x.id===pid)).filter(Boolean);
  const full=occ.length>=r.capacidad;
  const pct=r.capacidad>0?Math.round(occ.length/r.capacidad*100):0;
  const avail=people.filter(x=>!x.roomId&&!x.waitlist);
  const personsHTML=occ.length===0
    ?'<div class="room-empty">Sin ocupantes</div>'
    :occ.map(p=>'<div class="rperson">'
      +'<div class="rperson-name" onclick="openPersonModal('+p.id+')">'+p.nombre+(p.comida==='vegetariano'?' <span style="font-size:0.7rem">🥦</span>':'')+'</div>'
      +'<div class="rperson-age">'+p.edad+'a</div>'
      +pagoLabel(p)
      +'<button class="btn-rx" onclick="removePerson('+p.id+','+r.id+')">✕</button>'
      +'</div>').join('');
  const assignBtn=(!full&&avail.length>0)
    ?'<button class="btn-sm primary" onclick="openAssignFromRoom('+r.id+')">+ Asignar</button>'
    :'';
  return '<div class="room-card'+(full?' full':'')+'">'
    +'<div class="room-hdr">'
    +'<span class="room-name">'+r.nombre+'</span>'
    +'<span class="room-badge'+(full?' full':'')+'">'+occ.length+'/'+r.capacidad+'</span>'
    +'</div>'
    +'<div class="room-body">'
    +'<div class="progress-bg"><div class="progress-fill" style="width:'+pct+'%"></div></div>'
    +personsHTML
    +'</div>'
    +'<div class="room-footer">'
    +assignBtn
    +'<button class="btn-sm" onclick="openEditRoom('+r.id+')">Editar</button>'
    +'<button class="btn-sm danger" onclick="deleteRoom('+r.id+')">Eliminar</button>'
    +'</div>'
    +'</div>';
}
function subsectorStats(roomList){
  const cap=roomList.reduce((s,r)=>s+r.capacidad,0);
  const occ=roomList.reduce((s,r)=>s+r.personas.length,0);
  return `${occ}/${cap}`;
}
function getCGSubsector(r){
  // Extract hab number from name for default rooms; fallback to subsector property
  if(r.subsector) return r.subsector;
  const m=r.nombre.match(/\d+/);
  if(!m) return 'baja';
  const n=parseInt(m[0]);
  if(n>=1&&n<=13) return 'alta';
  if(n>=16&&n<=19) return 'vip';
  return 'baja';
}
function renderRooms(sector){
  const sr=rooms.filter(r=>r.sector===sector);
  const cap=sr.reduce((s,r)=>s+r.capacidad,0);
  const occ=sr.reduce((s,r)=>s+r.personas.length,0);
  document.getElementById('tag-'+sector.toLowerCase()).textContent=`${occ}/${cap} · ${sr.length} hab.`;

  if(sector==='CH'){
    const gridEl=document.getElementById('grid-ch');
    gridEl.innerHTML=sr.length===0
      ?'<div class="empty" style="grid-column:1/-1"><div class="ei">🏠</div><p>Sin habitaciones.</p></div>'
      :sr.map(r=>roomCardHTML(r)).join('');
    return;
  }

  // Casa Grande — 3 subsectors
  const alta=sr.filter(r=>getCGSubsector(r)==='alta');
  const vip=sr.filter(r=>getCGSubsector(r)==='vip');
  const baja=sr.filter(r=>getCGSubsector(r)==='baja');
  const subsectors=[['alta',alta],['vip',vip],['baja',baja]];
  subsectors.forEach(([key,list])=>{
    const tagEl=document.getElementById('tag-cg-'+key);
    if(tagEl) tagEl.textContent=subsectorStats(list)+' · '+list.length+' hab.';
    const gridEl=document.getElementById('grid-cg-'+key);
    if(!gridEl) return;
    gridEl.innerHTML=list.length===0
      ?'<div class="empty" style="grid-column:1/-1;padding:14px"><p>Sin habitaciones en este sector</p></div>'
      :list.map(r=>roomCardHTML(r)).join('');
    gridEl.classList.toggle('collapsed',!sectionState['cg-'+key]);
  });
}

function renderDiagramGroup(gridId, list, tagId, emptyLabel){
  const gridEl=document.getElementById(gridId);
  if(!gridEl) return;
  const cap=list.reduce((s,r)=>s+r.capacidad,0);
  const occ=list.reduce((s,r)=>s+r.personas.length,0);
  const tagEl=document.getElementById(tagId);
  if(tagEl) tagEl.textContent=`${occ}/${cap} · ${list.length} hab.`;
  gridEl.innerHTML=list.length===0
    ?`<div class="empty" style="grid-column:1/-1"><div class="ei">🏠</div><p>${emptyLabel||'Sin habitaciones.'}</p></div>`
    :list.map(r=>roomCardHTML(r)).join('');
}

function renderDiagrama(){
  const cg=rooms.filter(r=>r.sector==='CG');
  const alta=cg.filter(r=>getCGSubsector(r)==='alta');
  const baja=cg.filter(r=>['baja','vip'].includes(getCGSubsector(r)));
  const ch=rooms.filter(r=>r.sector==='CH');
  renderDiagramGroup('diag-baja',baja,'tag-diag-baja','Sin habitaciones en planta baja.');
  renderDiagramGroup('diag-alta',alta,'tag-diag-alta','Sin habitaciones en planta alta.');
  renderDiagramGroup('diag-ch',ch,'tag-diag-ch','Sin habitaciones en chalecito.');
  renderDiagramMap('map-baja',DIAGRAM_LAYOUTS.baja,baja);
  renderDiagramMap('map-alta',DIAGRAM_LAYOUTS.alta,alta);
  renderDiagramMap('map-ch',DIAGRAM_LAYOUTS.ch,ch);
}

function renderLista(){
  const q=(document.getElementById('filt-q').value||'').toLowerCase();
  const fp=document.getElementById('filt-pago').value;
  const fe=document.getElementById('filt-est').value;
  let list=[...people];
  if(q) list=list.filter(p=>p.nombre.toLowerCase().includes(q));
  if(fp) list=list.filter(p=>p.pago===fp);
  if(fe==='anotado') list=list.filter(p=>!p.waitlist);
  if(fe==='espera') list=list.filter(p=>p.waitlist);
  const fc=document.getElementById('filt-comida').value;
  if(fc) list=list.filter(p=>p.comida===fc);
  list.sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));

  const tbody=document.getElementById('list-tbody');
  if(list.length===0){
    tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--muted);font-style:italic">Sin resultados.</td></tr>`;
    return;
  }
  tbody.innerHTML=list.map((p,i)=>{
    const hab=p.roomId?(rooms.find(x=>x.id===p.roomId)||{nombre:'—'}).nombre:(p.waitlist?'En espera':'Sin asignar');
    const deuda=calcDeuda(p);
    return `<tr>
      <td style="color:var(--muted);font-size:0.72rem">${i+1}</td>
      <td style="font-weight:500">${p.nombre}</td>
      <td>${p.ciudad}</td>
      <td>${p.tel||'—'}</td>
      <td>${grupoHTML(p)}</td>
      <td>${p.comida==='vegetariano'?'🥦 Veg.':'🍽 Normal'}</td>
      <td style="font-size:0.78rem">${hab}</td>
      <td>${pagoLabel(p)}</td>
      <td class="${deuda>0?'deuda-cell':''}">${deuda>0?'$'+fmt(deuda):'—'}</td>
    </tr>`;
  }).join('');
}

// ── CONFIRM MODAL ──
let _confirmCb=null;
function openConfirm(title, msg, cb){
  document.getElementById('mc-title').textContent=title;
  document.getElementById('mc-body').textContent=msg;
  _confirmCb=cb;
  document.getElementById('mc-ok').onclick=function(){
    closeModal('m-confirm');
    if(_confirmCb) _confirmCb();
    _confirmCb=null;
  };
  openModal('m-confirm');
}
function openResetConfirm(){
  openConfirm(
    'Limpiar todo',
    'Esta acción eliminará todas las personas anotadas, en lista de espera y reseteará las habitaciones. Los precios se mantienen. No se puede deshacer.',
    async function(){
      try{
        const data=await apiFetch('/api/reset',{method:'POST'});
        hydrateState(data);
        render();
        savePending=false;
        setSaveStatus('clean');
      }catch(err){
        alert(err.message||'No se pudo limpiar el retiro.');
      }
    }
  );
}

async function archiveRetiro(){
  try{
    await persistState(true);
    const data=await apiFetch('/api/archive',{method:'POST',body:JSON.stringify({house:'Villa Marista'})});
    alert('Retiro archivado correctamente ('+(data.archiveName||'archivo')+').');
  }catch(err){
    alert(err.message||'No se pudo archivar el retiro.');
  }
}

document.getElementById('login-pass').addEventListener('keydown',e=>{if(e.key==='Enter')login();});

setInterval(()=>{persistState();},AUTOSAVE_INTERVAL_MS);

initDiagramViewports();

async function bootstrap(){
  if(!authToken){
    document.getElementById('m-login').classList.add('active');
    setSaveStatus('clean');
    return;
  }
  try{
    await apiFetch('/api/session');
    await loadServerState();
    isBootstrapping=true;
    render();
    isBootstrapping=false;
    setSaveStatus('clean');
    document.getElementById('m-login').classList.remove('active');
  }catch(_){
    sessionStorage.removeItem('retiro-auth-token');
    authToken='';
    document.getElementById('m-login').classList.add('active');
    setSaveStatus('clean');
  }
}

bootstrap();
