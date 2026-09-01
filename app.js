/* FireSector Responder PWA v001 */
const SUPABASE_URL='https://gekvveymihsskkuxgxve.supabase.co';
const SUPABASE_KEY='sb_publishable_nU5RxgAg5gq0Gr53Fb-F_w_Z6_dS3qe';
const HEARTBEAT_BASE_MS=20000;
const HEARTBEAT_JITTER_MS=5000;
const REQUEST_TIMEOUT_MS=10000;
const DB_NAME='firesector_responder';
const DB_VERSION=1;
const DB_STORE='state';

const $=id=>document.getElementById(id);
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const toRad=value=>value*Math.PI/180;

let activeAccess=null;
let currentSnapshot=null;
let currentMarkers=[];
let selectedMarkerId=null;
let navigationWaterId=null;
let currentLocation=null;
let currentHeading=null;
let installPrompt=null;
let countdownTimer=null;
let heartbeatTimer=null;
let heartbeatRunning=false;
let lastHeartbeatAt=0;
let locationWatchId=null;
let orientationListening=false;
let mapMode='terrain';
let online=navigator.onLine;

const mapState={
  centerLat:-28.95,
  centerLon:25.70,
  zoom:11,
  pointers:new Map(),
  dragging:false,
  moved:false,
  startX:0,
  startY:0,
  startCenterWorld:null,
  pinchDistance:null
};

const FARM_DEFINITIONS=[
  {name:'Lovedale',number:'1844 RD',private:false,url:"https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/20/query?where=PARCEL_NO%3D1844&geometry=25.689453%2C-28.911699&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=4326&f=geojson"},
  {name:'Dam Vallei',number:'29 RD',private:false,url:"https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/20/query?where=PARCEL_NO%3D29%20AND%20MAJ_REGION%20LIKE%20%27BLOEMFONTEIN%25%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson"},
  {name:'Strydoms Pan',number:'348 RD',private:false,url:"https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/20/query?where=PARCEL_NO%3D348%20AND%20MAJ_REGION%20LIKE%20%27BLOEMFONTEIN%25%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson"},
  {name:'Helder Fontein',number:'754 RD',private:false,url:"https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/20/query?where=PARCEL_NO%3D754%20AND%20MAJ_REGION%20LIKE%20%27BLOEMFONTEIN%25%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson"},
  {name:'Kromdraai',number:'558 RD',private:true,url:"https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/20/query?where=PARCEL_NO%3D558%20AND%20MAJ_REGION%20LIKE%20%27BLOEMFONTEIN%25%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson"},
  {name:'Rooipan',number:'686 RD',private:false,url:"https://maps.geoscience.org.za/hosting/rest/services/Administrative_Boundaries_and_Cadastral_Data/MapServer/20/query?where=PARCEL_NO%3D686%20AND%20MAJ_REGION%20LIKE%20%27BLOEMFONTEIN%25%27&outFields=*&returnGeometry=true&outSR=4326&f=geojson"}
];
let farmGeometry=[];

function formatAccessCode(value){
  const raw=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,10);
  if(raw.length<=2)return raw;
  if(raw.length<=6)return `${raw.slice(0,2)}-${raw.slice(2)}`;
  return `${raw.slice(0,2)}-${raw.slice(2,6)}-${raw.slice(6)}`;
}

function normaliseAccessCode(value){
  const raw=String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,10);
  return raw.length===10&&raw.startsWith('FS')?`${raw.slice(0,2)}-${raw.slice(2,6)}-${raw.slice(6)}`:null;
}

function showAccessError(message){
  $('accessError').textContent=message;
  $('accessError').classList.toggle('hidden',!message);
}

function setScreen(mapOpen){
  $('accessScreen').classList.toggle('hidden',mapOpen);
  $('mapScreen').classList.toggle('hidden',!mapOpen);
}

async function rpc(name,payload){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:SUPABASE_KEY},
      body:JSON.stringify(payload),
      signal:controller.signal,
      cache:'no-store'
    });
    const text=await response.text();
    let body=null;
    try{body=text?JSON.parse(text):null}catch(_){body=text}
    if(!response.ok)throw new Error(`Request failed (${response.status})`);
    return {reached:true,body};
  }catch(error){
    return {reached:false,error};
  }finally{
    clearTimeout(timer);
  }
}

async function validateCode(code){
  const response=await rpc('validate_temporary_access_code',{
    p_code:code,
    p_device_id_hash:null,
    p_user_agent:'FireSector Responder PWA'
  });
  if(!response.reached)throw new Error('Unable to connect to FireSector.');
  const row=Array.isArray(response.body)?response.body[0]:null;
  if(!row?.session_token)throw new Error('Invalid or expired access code.');
  return {
    sessionId:String(row.session_id||''),
    sessionToken:String(row.session_token),
    accessCodeId:String(row.access_code_id||''),
    districtId:String(row.district_id||''),
    districtCode:String(row.district_code||''),
    areaName:String(row.district_name||'FireSector'),
    scopeType:String(row.scope_type||'district').toLowerCase(),
    centerLatitude:toNumber(row.center_latitude),
    centerLongitude:toNumber(row.center_longitude),
    radiusKm:toNumber(row.radius_km),
    validFrom:row.valid_from||null,
    expiresAt:row.expires_at||null
  };
}

function toNumber(value){
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)?n:null;
}

function validateSnapshot(raw,access){
  if(!raw||typeof raw!=='object')throw new Error('Invalid map snapshot.');
  const districtId=String(raw.district_id||'');
  const accessCodeId=String(raw.access_code_id||'');
  const scopeType=String(raw.scope_type||'').toLowerCase();
  const versionNo=Number(raw.version_no);
  if(!districtId||!accessCodeId||!Number.isInteger(versionNo)||versionNo<0)throw new Error('Invalid map snapshot.');
  if(access&&access.districtId&&districtId!==access.districtId)throw new Error('Map snapshot does not match access.');
  if(access&&access.accessCodeId&&accessCodeId!==access.accessCodeId)throw new Error('Map snapshot does not match incident.');
  if(!['district','radius'].includes(scopeType))throw new Error('Invalid map scope.');
  const centerLatitude=toNumber(raw.center_latitude);
  const centerLongitude=toNumber(raw.center_longitude);
  const radiusKm=toNumber(raw.radius_km);
  if(scopeType==='radius'&&(centerLatitude===null||centerLongitude===null||radiusKm===null||radiusKm<=0))throw new Error('Invalid access radius.');
  if(!Array.isArray(raw.markers))throw new Error('Map markers are missing.');
  const ids=new Set();
  const markers=raw.markers.map(item=>{
    const id=String(item?.id||'');
    const markerType=String(item?.marker_type||'').toLowerCase();
    const latitude=toNumber(item?.latitude);
    const longitude=toNumber(item?.longitude);
    if(!id||ids.has(id)||!['water','gate','landmark','fire'].includes(markerType)||latitude===null||longitude===null||latitude<-90||latitude>90||longitude<-180||longitude>180)throw new Error('Invalid marker data.');
    ids.add(id);
    if(scopeType==='radius'&&distanceKm(centerLatitude,centerLongitude,latitude,longitude)>radiusKm+0.01)throw new Error('Marker outside access radius.');
    return {
      id,markerType,
      name:cleanText(item.name)||markerTypeLabel(markerType),
      latitude,longitude,
      status:cleanText(item.status),
      subtype:cleanText(item.subtype),
      availability:cleanText(item.availability),
      notes:cleanText(item.notes),
      farmId:cleanText(item.farm_id),
      farmName:cleanText(item.farm_name),
      updatedAt:cleanText(item.updated_at)
    };
  });
  return {
    accessCodeId,districtId,
    districtCode:cleanText(raw.district_code),
    districtName:cleanText(raw.district_name),
    versionNo,
    versionUpdatedAt:cleanText(raw.version_updated_at),
    generatedAt:cleanText(raw.generated_at),
    scopeType,centerLatitude,centerLongitude,radiusKm,
    expiresAt:cleanText(raw.expires_at),
    markers
  };
}

function cleanText(value){
  const text=value===null||value===undefined?'':String(value).trim();
  return text||null;
}

function markerTypeLabel(type){
  return type==='water'?'Water Point':type==='gate'?'Gate':type==='landmark'?'Landmark':type==='fire'?'Fire Point':'Marker';
}

function distanceKm(lat1,lon1,lat2,lon2){
  const r=6371.0088;
  const dLat=toRad(lat2-lat1);
  const dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return r*2*Math.asin(Math.sqrt(a));
}

function formatDistance(km){
  if(!Number.isFinite(km))return '—';
  return km<1?`${Math.round(km*1000)} m`:`${km.toFixed(km<10?1:0)} km`;
}

function latLonToWorld(lat,lon,zoom){
  const scale=256*Math.pow(2,zoom);
  const sin=Math.sin(clamp(lat,-85.05112878,85.05112878)*Math.PI/180);
  return {
    x:(lon+180)/360*scale,
    y:(0.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*scale
  };
}

function worldToLatLon(x,y,zoom){
  const scale=256*Math.pow(2,zoom);
  const lon=x/scale*360-180;
  const n=Math.PI-2*Math.PI*y/scale;
  const lat=180/Math.PI*Math.atan(Math.sinh(n));
  return {lat:clamp(lat,-85.05112878,85.05112878),lon};
}

function mapRadiusPixels(lat,radiusKm,zoom){
  const metresPerPixel=156543.03392*Math.max(.01,Math.cos(lat*Math.PI/180))/Math.pow(2,zoom);
  return Math.max(1,radiusKm*1000/metresPerPixel);
}

function tileUrl(z,x,y){
  if(mapMode==='satellite')return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function renderMap(){
  const map=$('map');
  $('mapAttribution').textContent=mapMode==='satellite'?'Tiles © Esri':'© OpenStreetMap contributors';
  if(!map||map.clientWidth<10||map.clientHeight<10)return;
  const width=map.clientWidth;
  const height=map.clientHeight;
  const z=mapState.zoom;
  const center=latLonToWorld(mapState.centerLat,mapState.centerLon,z);
  const left=center.x-width/2;
  const top=center.y-height/2;
  const minTileX=Math.floor(left/256);
  const maxTileX=Math.floor((left+width)/256);
  const minTileY=Math.floor(top/256);
  const maxTileY=Math.floor((top+height)/256);
  const tileCount=Math.pow(2,z);
  const fragment=document.createDocumentFragment();
  for(let ty=minTileY;ty<=maxTileY;ty++){
    if(ty<0||ty>=tileCount)continue;
    for(let tx=minTileX;tx<=maxTileX;tx++){
      const wrappedX=((tx%tileCount)+tileCount)%tileCount;
      const img=document.createElement('img');
      img.className='map-tile';
      img.alt='';
      img.draggable=false;
      img.src=tileUrl(z,wrappedX,ty);
      img.style.left=`${tx*256-left}px`;
      img.style.top=`${ty*256-top}px`;
      fragment.appendChild(img);
    }
  }
  $('tileLayer').replaceChildren(fragment);
  renderRadius(left,top,z);
  renderFarmGeometry(left,top,z,width,height);
  renderMarkers(left,top,z,width,height);
  renderCurrentLocation(left,top,z);
  renderNavigation(left,top,z);
}

function screenPoint(lat,lon,left,top,z){
  const p=latLonToWorld(lat,lon,z);
  return {x:p.x-left,y:p.y-top};
}

function renderRadius(left,top,z){
  const overlay=$('radiusOverlay');
  const source=currentSnapshot||activeAccess;
  if(!source||source.scopeType!=='radius'||source.centerLatitude===null||source.centerLongitude===null||source.radiusKm===null){
    overlay.classList.add('hidden');
    return;
  }
  const p=screenPoint(source.centerLatitude,source.centerLongitude,left,top,z);
  const radiusPx=mapRadiusPixels(source.centerLatitude,source.radiusKm,z);
  overlay.style.left=`${p.x-radiusPx}px`;
  overlay.style.top=`${p.y-radiusPx}px`;
  overlay.style.width=`${radiusPx*2}px`;
  overlay.style.height=`${radiusPx*2}px`;
  overlay.classList.remove('hidden');
}

function renderMarkers(left,top,z,width,height){
  const layer=$('markerLayer');
  const fragment=document.createDocumentFragment();
  let selected=null;
  for(const marker of currentMarkers){
    const p=screenPoint(marker.latitude,marker.longitude,left,top,z);
    if(p.x<-80||p.y<-80||p.x>width+80||p.y>height+80)continue;
    const button=document.createElement('button');
    button.type='button';
    button.className=`map-marker ${marker.markerType}${marker.id===selectedMarkerId?' selected':''}`;
    button.dataset.markerId=marker.id;
    button.style.left=`${p.x}px`;
    button.style.top=`${p.y}px`;
    button.setAttribute('aria-label',`${markerTypeLabel(marker.markerType)}: ${marker.name}`);
    fragment.appendChild(button);
    if(marker.id===selectedMarkerId)selected={marker,p};
  }
  layer.replaceChildren(fragment);
  if(selected)renderMarkerDetails(selected.marker,selected.p,width,height);
  else $('markerDetails').classList.add('hidden');
}

function renderMarkerDetails(marker,p,width,height){
  const details=$('markerDetails');
  const rows=[];
  if(marker.subtype)rows.push(['Type',marker.subtype]);
  if(marker.status)rows.push([marker.markerType==='gate'?'Access':marker.markerType==='landmark'?'Visibility':'Status',marker.status]);
  if(marker.availability)rows.push(['Availability',marker.availability]);
  if(marker.farmName)rows.push(['Farm',marker.farmName]);
  if(marker.notes)rows.push(['Notes',marker.notes]);
  details.innerHTML=`<strong>${escapeHtml(marker.name)}</strong><dl>${rows.map(([k,v])=>`<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>${marker.markerType==='water'?'<button class="detail-action" type="button" data-water-nav="1">Navigate</button>':''}`;
  const x=clamp(p.x,150,width-150);
  let y=p.y;
  if(y<180){
    details.style.transform='translate(-50%,42px)';
  }else{
    details.style.transform='translate(-50%,calc(-100% - 38px))';
  }
  details.style.left=`${x}px`;
  details.style.top=`${y}px`;
  details.classList.remove('hidden');
}

function escapeHtml(value){
  return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}

function renderCurrentLocation(left,top,z){
  if(!currentLocation){
    $('locationDot').classList.add('hidden');
    $('locationCone').classList.add('hidden');
    return;
  }
  const p=screenPoint(currentLocation.lat,currentLocation.lon,left,top,z);
  $('locationDot').style.left=`${p.x}px`;
  $('locationDot').style.top=`${p.y}px`;
  $('locationDot').classList.remove('hidden');
  if(Number.isFinite(currentHeading)){
    $('locationCone').style.left=`${p.x}px`;
    $('locationCone').style.top=`${p.y}px`;
    $('locationCone').style.transform=`rotate(${currentHeading}deg)`;
    $('locationCone').classList.remove('hidden');
  }else{
    $('locationCone').classList.add('hidden');
  }
}

function renderNavigation(left,top,z){
  const svg=$('navigationLayer');
  if(!currentLocation||!navigationWaterId){
    svg.replaceChildren();
    return;
  }
  const target=currentMarkers.find(m=>m.id===navigationWaterId&&m.markerType==='water');
  if(!target){
    navigationWaterId=null;
    $('navigationCard').classList.add('hidden');
    svg.replaceChildren();
    return;
  }
  const a=screenPoint(currentLocation.lat,currentLocation.lon,left,top,z);
  const b=screenPoint(target.latitude,target.longitude,left,top,z);
  svg.setAttribute('viewBox',`0 0 ${$('map').clientWidth} ${$('map').clientHeight}`);
  svg.innerHTML=`<line class="navigation-line" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>`;
  const km=distanceKm(currentLocation.lat,currentLocation.lon,target.latitude,target.longitude);
  $('navigationName').textContent=target.name;
  $('navigationDistance').textContent=`${target.subtype||'Water Point'} • ${formatDistance(km)} direct`;
  $('navigationCard').classList.remove('hidden');
}

function geometryRings(geometry){
  if(!geometry)return [];
  if(geometry.type==='Polygon')return geometry.coordinates||[];
  if(geometry.type==='MultiPolygon')return (geometry.coordinates||[]).flat();
  return [];
}

function centroidForRings(rings){
  const points=rings.flat();
  if(!points.length)return null;
  let x=0,y=0;
  for(const point of points){x+=Number(point[0]);y+=Number(point[1]);}
  return {lon:x/points.length,lat:y/points.length};
}

function renderFarmGeometry(left,top,z,width,height){
  const svg=$('farmBoundaryLayer');
  svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const parts=[];
  for(const farm of farmGeometry){
    const rings=geometryRings(farm.geometry);
    for(const ring of rings){
      const coords=ring.map(([lon,lat])=>screenPoint(Number(lat),Number(lon),left,top,z));
      if(!coords.length)continue;
      const d=coords.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')+' Z';
      parts.push(`<path class="farm-boundary${farm.private?' private':''}" d="${d}"></path>`);
    }
    const c=centroidForRings(rings);
    if(c){
      const p=screenPoint(c.lat,c.lon,left,top,z);
      if(p.x>-100&&p.y>-50&&p.x<width+100&&p.y<height+50)parts.push(`<text class="farm-label" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" text-anchor="middle">${escapeHtml(farm.name)} ${escapeHtml(farm.number)}</text>`);
    }
  }
  svg.innerHTML=parts.join('');
}

async function loadFarmBoundaries(){
  const loaded=[];
  await Promise.all(FARM_DEFINITIONS.map(async farm=>{
    try{
      const response=await fetch(farm.url,{cache:'force-cache'});
      if(!response.ok)return;
      const json=await response.json();
      const feature=Array.isArray(json?.features)?json.features[0]:null;
      if(feature?.geometry)loaded.push({...farm,geometry:feature.geometry});
    }catch(_){ }
  }));
  farmGeometry=loaded;
  renderMap();
}

function mapPointFromEvent(event){
  const rect=$('map').getBoundingClientRect();
  const center=latLonToWorld(mapState.centerLat,mapState.centerLon,mapState.zoom);
  return worldToLatLon(
    center.x+(event.clientX-rect.left-rect.width/2),
    center.y+(event.clientY-rect.top-rect.height/2),
    mapState.zoom
  );
}

function initialiseMapInteractions(){
  const map=$('map');
  map.addEventListener('pointerdown',event=>{
    if(event.target.closest('button,.marker-details,.responder-header,.navigation-card'))return;
    mapState.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    map.setPointerCapture(event.pointerId);
    if(mapState.pointers.size===1){
      mapState.dragging=true;
      mapState.moved=false;
      mapState.startX=event.clientX;
      mapState.startY=event.clientY;
      mapState.startCenterWorld=latLonToWorld(mapState.centerLat,mapState.centerLon,mapState.zoom);
      map.classList.add('dragging');
    }else if(mapState.pointers.size===2){
      const pts=[...mapState.pointers.values()];
      mapState.pinchDistance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
    }
  });

  map.addEventListener('pointermove',event=>{
    if(!mapState.pointers.has(event.pointerId))return;
    mapState.pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(mapState.pointers.size===2){
      const pts=[...mapState.pointers.values()];
      const dist=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
      if(mapState.pinchDistance&&Math.abs(dist-mapState.pinchDistance)>45){
        mapState.zoom=clamp(mapState.zoom+(dist>mapState.pinchDistance?1:-1),4,18);
        mapState.pinchDistance=dist;
        mapState.startCenterWorld=latLonToWorld(mapState.centerLat,mapState.centerLon,mapState.zoom);
        renderMap();
      }
      return;
    }
    if(!mapState.dragging)return;
    const dx=event.clientX-mapState.startX;
    const dy=event.clientY-mapState.startY;
    if(Math.abs(dx)+Math.abs(dy)>5)mapState.moved=true;
    const next=worldToLatLon(mapState.startCenterWorld.x-dx,mapState.startCenterWorld.y-dy,mapState.zoom);
    mapState.centerLat=next.lat;
    mapState.centerLon=next.lon;
    renderMap();
  });

  const endPointer=event=>{
    mapState.pointers.delete(event.pointerId);
    if(mapState.pointers.size<2)mapState.pinchDistance=null;
    if(mapState.pointers.size===0){
      mapState.dragging=false;
      map.classList.remove('dragging');
      if(!mapState.moved&&!event.target.closest('.map-marker,.marker-details')){
        selectedMarkerId=null;
        renderMap();
      }
    }
  };
  map.addEventListener('pointerup',endPointer);
  map.addEventListener('pointercancel',endPointer);

  map.addEventListener('wheel',event=>{
    event.preventDefault();
    mapState.zoom=clamp(mapState.zoom+(event.deltaY<0?1:-1),4,18);
    renderMap();
  },{passive:false});

  map.addEventListener('dblclick',event=>{
    event.preventDefault();
    const point=mapPointFromEvent(event);
    mapState.centerLat=point.lat;
    mapState.centerLon=point.lon;
    mapState.zoom=clamp(mapState.zoom+1,4,18);
    renderMap();
  });

  $('markerLayer').addEventListener('click',event=>{
    const button=event.target.closest('.map-marker');
    if(!button)return;
    event.stopPropagation();
    selectedMarkerId=button.dataset.markerId||null;
    renderMap();
  });

  $('markerDetails').addEventListener('click',event=>{
    if(event.target.closest('[data-water-nav]'))startWaterNavigation(selectedMarkerId);
  });

  $('zoomIn').addEventListener('click',()=>{mapState.zoom=clamp(mapState.zoom+1,4,18);renderMap();});
  $('zoomOut').addEventListener('click',()=>{mapState.zoom=clamp(mapState.zoom-1,4,18);renderMap();});
}

function startLocationTracking(){
  if(!navigator.geolocation)return;
  if(locationWatchId!==null)return;
  locationWatchId=navigator.geolocation.watchPosition(position=>{
    const fresh={lat:position.coords.latitude,lon:position.coords.longitude,accuracy:position.coords.accuracy};
    const first=!currentLocation;
    currentLocation=fresh;
    if(first){
      mapState.centerLat=fresh.lat;
      mapState.centerLon=fresh.lon;
      mapState.zoom=Math.max(mapState.zoom,15);
    }
    renderMap();
  },()=>{}, {enableHighAccuracy:true,maximumAge:3000,timeout:15000});
}

async function requestCompassPermission(){
  try{
    if(typeof DeviceOrientationEvent!=='undefined'&&typeof DeviceOrientationEvent.requestPermission==='function'){
      const result=await DeviceOrientationEvent.requestPermission();
      if(result!=='granted')return;
    }
  }catch(_){return;}
  startOrientationListener();
}

function startOrientationListener(){
  if(orientationListening||typeof DeviceOrientationEvent==='undefined')return;
  orientationListening=true;
  window.addEventListener('deviceorientation',event=>{
    let heading=null;
    if(Number.isFinite(event.webkitCompassHeading))heading=event.webkitCompassHeading;
    else if(Number.isFinite(event.alpha))heading=(360-event.alpha)%360;
    if(Number.isFinite(heading)){
      currentHeading=heading;
      renderMap();
    }
  },true);
}

async function recenterCurrentLocation(){
  await requestCompassPermission();
  startLocationTracking();
  if(currentLocation){
    mapState.centerLat=currentLocation.lat;
    mapState.centerLon=currentLocation.lon;
    mapState.zoom=Math.max(mapState.zoom,15);
    renderMap();
    return;
  }
  if(!navigator.geolocation)return;
  navigator.geolocation.getCurrentPosition(position=>{
    currentLocation={lat:position.coords.latitude,lon:position.coords.longitude,accuracy:position.coords.accuracy};
    mapState.centerLat=currentLocation.lat;
    mapState.centerLon=currentLocation.lon;
    mapState.zoom=Math.max(mapState.zoom,15);
    renderMap();
  },()=>{}, {enableHighAccuracy:true,timeout:12000,maximumAge:0});
}

function startWaterNavigation(markerId){
  const marker=currentMarkers.find(m=>m.id===markerId&&m.markerType==='water');
  if(!marker)return;
  navigationWaterId=marker.id;
  selectedMarkerId=marker.id;
  closeMenu();
  recenterCurrentLocation();
  renderMap();
}

function navigateNearestWater(){
  if(!currentLocation){
    closeMenu();
    recenterCurrentLocation();
    return;
  }
  const waters=currentMarkers.filter(m=>m.markerType==='water');
  if(!waters.length)return;
  let nearest=waters[0];
  let best=Infinity;
  for(const water of waters){
    const d=distanceKm(currentLocation.lat,currentLocation.lon,water.latitude,water.longitude);
    if(d<best){best=d;nearest=water;}
  }
  navigationWaterId=nearest.id;
  selectedMarkerId=nearest.id;
  mapState.centerLat=(currentLocation.lat+nearest.latitude)/2;
  mapState.centerLon=(currentLocation.lon+nearest.longitude)/2;
  mapState.zoom=Math.max(mapState.zoom,13);
  closeMenu();
  renderMap();
}

function stopWaterNavigation(){
  navigationWaterId=null;
  $('navigationCard').classList.add('hidden');
  renderMap();
}

function updateCountdown(){
  if(!activeAccess?.expiresAt){$('countdown').textContent='—';return;}
  const remaining=new Date(activeAccess.expiresAt).getTime()-Date.now();
  if(remaining<=0){endTemporaryAccess(true);return;}
  const total=Math.floor(remaining/1000);
  const days=Math.floor(total/86400);
  const hours=Math.floor((total%86400)/3600);
  const minutes=Math.floor((total%3600)/60);
  const seconds=total%60;
  const hh=String(hours).padStart(2,'0');
  const mm=String(minutes).padStart(2,'0');
  const ss=String(seconds).padStart(2,'0');
  $('countdown').textContent=days?`${days}d ${hh}:${mm}:${ss}`:`${hh}:${mm}:${ss}`;
}

function updateMenuMeta(){
  $('menuAreaName').textContent=activeAccess?.areaName||currentSnapshot?.districtName||'FireSector';
  const source=currentSnapshot||activeAccess;
  $('menuScope').textContent=source?.scopeType==='radius'?`${source.radiusKm} km radius`:'Entire area';
}

function showOfflineBadge(show){
  $('syncBadge').classList.toggle('hidden',!show);
}

async function getVersionState(){
  const response=await rpc('get_firesector_map_data_version',{p_session_token:activeAccess.sessionToken});
  if(!response.reached)return {reached:false};
  const row=Array.isArray(response.body)?response.body[0]:null;
  if(!row)return {reached:true,active:false};
  return {
    reached:true,active:true,
    versionNo:Number(row.version_no),
    districtId:String(row.district_id||''),
    areaName:String(row.district_name||activeAccess.areaName||'FireSector'),
    scopeType:String(row.scope_type||activeAccess.scopeType||'district').toLowerCase(),
    centerLatitude:toNumber(row.center_latitude),
    centerLongitude:toNumber(row.center_longitude),
    radiusKm:toNumber(row.radius_km),
    expiresAt:row.expires_at||activeAccess.expiresAt
  };
}

async function fetchSnapshot(){
  const response=await rpc('get_firesector_map_data_snapshot',{p_session_token:activeAccess.sessionToken});
  if(!response.reached)return null;
  let raw=response.body;
  if(Array.isArray(raw)&&raw.length===1&&raw[0]&&typeof raw[0]==='object')raw=raw[0];
  if(typeof raw==='string'){
    try{raw=JSON.parse(raw)}catch(_){return null}
  }
  if(!raw||typeof raw!=='object')return null;
  return validateSnapshot(raw,activeAccess);
}

function geometryDiffers(state,snapshot){
  const near=(a,b)=>a===null&&b===null||Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-9;
  return state.scopeType!==snapshot.scopeType||!near(state.centerLatitude,snapshot.centerLatitude)||!near(state.centerLongitude,snapshot.centerLongitude)||!near(state.radiusKm,snapshot.radiusKm);
}

async function heartbeat({force=false}={}){
  if(!activeAccess||heartbeatRunning)return;
  if(!force&&Date.now()-lastHeartbeatAt<5000)return;
  heartbeatRunning=true;
  lastHeartbeatAt=Date.now();
  try{
    const state=await getVersionState();
    if(!state.reached){
      showOfflineBadge(true);
      return;
    }
    showOfflineBadge(false);
    if(!state.active){
      endTemporaryAccess(true);
      return;
    }
    activeAccess={...activeAccess,
      areaName:state.areaName,
      scopeType:state.scopeType,
      centerLatitude:state.centerLatitude,
      centerLongitude:state.centerLongitude,
      radiusKm:state.radiusKm,
      expiresAt:state.expiresAt
    };
    await saveSession(activeAccess);
    updateCountdown();
    updateMenuMeta();

    const needsSnapshot=!currentSnapshot||currentSnapshot.versionNo!==state.versionNo||currentSnapshot.districtId!==state.districtId||geometryDiffers(state,currentSnapshot);
    if(needsSnapshot){
      const fresh=await fetchSnapshot();
      if(fresh){
        await saveSnapshotAtomic(fresh);
        currentSnapshot=fresh;
        currentMarkers=fresh.markers;
        activeAccess={...activeAccess,
          areaName:fresh.districtName||activeAccess.areaName,
          scopeType:fresh.scopeType,
          centerLatitude:fresh.centerLatitude,
          centerLongitude:fresh.centerLongitude,
          radiusKm:fresh.radiusKm,
          expiresAt:fresh.expiresAt||activeAccess.expiresAt
        };
        selectedMarkerId=currentMarkers.some(m=>m.id===selectedMarkerId)?selectedMarkerId:null;
        navigationWaterId=currentMarkers.some(m=>m.id===navigationWaterId&&m.markerType==='water')?navigationWaterId:null;
        renderMap();
      }
    }else{
      renderMap();
    }
  }finally{
    heartbeatRunning=false;
  }
}

function scheduleHeartbeat(){
  if(heartbeatTimer)clearTimeout(heartbeatTimer);
  if(!activeAccess)return;
  const delay=HEARTBEAT_BASE_MS+Math.floor(Math.random()*HEARTBEAT_JITTER_MS);
  heartbeatTimer=setTimeout(async()=>{
    await heartbeat();
    scheduleHeartbeat();
  },delay);
}

async function openAccess(access){
  activeAccess=access;
  currentSnapshot=await loadSnapshot(access);
  currentMarkers=currentSnapshot?.markers||[];
  if(currentSnapshot){
    mapState.centerLat=currentSnapshot.scopeType==='radius'&&currentSnapshot.centerLatitude!==null?currentSnapshot.centerLatitude:mapState.centerLat;
    mapState.centerLon=currentSnapshot.scopeType==='radius'&&currentSnapshot.centerLongitude!==null?currentSnapshot.centerLongitude:mapState.centerLon;
  }else if(access.scopeType==='radius'&&access.centerLatitude!==null&&access.centerLongitude!==null){
    mapState.centerLat=access.centerLatitude;
    mapState.centerLon=access.centerLongitude;
  }
  await saveSession(access);
  setScreen(true);
  updateMenuMeta();
  updateCountdown();
  if(countdownTimer)clearInterval(countdownTimer);
  countdownTimer=setInterval(updateCountdown,1000);
  renderMap();
  startLocationTracking();
  startOrientationListener();
  loadFarmBoundaries();
  await heartbeat({force:true});
  scheduleHeartbeat();
}

async function endTemporaryAccess(serverEnded=false){
  if(heartbeatTimer)clearTimeout(heartbeatTimer);
  heartbeatTimer=null;
  if(countdownTimer)clearInterval(countdownTimer);
  countdownTimer=null;
  activeAccess=null;
  currentSnapshot=null;
  currentMarkers=[];
  selectedMarkerId=null;
  navigationWaterId=null;
  await clearStoredState();
  closeMenu();
  setScreen(false);
  $('accessCode').value='';
  showAccessError(serverEnded?'Temporary Access has ended.':'');
}

function openMenu(){
  $('menuBackdrop').classList.remove('hidden');
  $('menuDrawer').classList.remove('hidden');
}
function closeMenu(){
  $('menuBackdrop').classList.add('hidden');
  $('menuDrawer').classList.add('hidden');
}

function initialiseUi(){
  $('accessCode').addEventListener('input',event=>{
    const formatted=formatAccessCode(event.target.value);
    if(event.target.value!==formatted)event.target.value=formatted;
    showAccessError('');
  });
  $('accessForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const code=normaliseAccessCode($('accessCode').value);
    if(!code){showAccessError('Enter a valid FireSector access code.');return;}
    const button=$('accessSubmit');
    button.disabled=true;
    button.textContent='Opening…';
    showAccessError('');
    try{
      const access=await validateCode(code);
      const clean=new URL(window.location.href);
      clean.search='';
      clean.hash='';
      history.replaceState({},'',clean.toString());
      await openAccess(access);
    }catch(error){
      showAccessError(error.message||'Could not open FireSector.');
    }finally{
      button.disabled=false;
      button.textContent='Open FireSector';
    }
  });

  $('menuButton').addEventListener('click',openMenu);
  $('closeMenu').addEventListener('click',closeMenu);
  $('menuBackdrop').addEventListener('click',closeMenu);
  $('recenter').addEventListener('click',recenterCurrentLocation);
  $('menuRecenter').addEventListener('click',()=>{closeMenu();recenterCurrentLocation();});
  $('nearestWater').addEventListener('click',navigateNearestWater);
  $('stopNavigation').addEventListener('click',stopWaterNavigation);
  $('toggleMapMode').addEventListener('click',()=>{
    mapMode=mapMode==='terrain'?'satellite':'terrain';
    $('mapModeLabel').textContent=mapMode==='terrain'?'Terrain':'Satellite';
    closeMenu();
    renderMap();
  });
  $('endAccess').addEventListener('click',()=>endTemporaryAccess(false));
  $('installButton').addEventListener('click',async()=>{
    if(!installPrompt)return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(()=>null);
    installPrompt=null;
    $('installButton').classList.add('hidden');
  });

  window.addEventListener('beforeinstallprompt',event=>{
    event.preventDefault();
    installPrompt=event;
    $('installButton').classList.remove('hidden');
  });
  window.addEventListener('appinstalled',()=>{
    installPrompt=null;
    $('installButton').classList.add('hidden');
  });
  window.addEventListener('online',()=>{
    online=true;
    showOfflineBadge(false);
    heartbeat({force:true});
  });
  window.addEventListener('offline',()=>{
    online=false;
    showOfflineBadge(true);
  });
  window.addEventListener('resize',renderMap);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'&&activeAccess){
      updateCountdown();
      heartbeat({force:true});
    }
  });
  window.addEventListener('focus',()=>{
    if(activeAccess)heartbeat({force:true});
  });
}

function openDb(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains(DB_STORE))db.createObjectStore(DB_STORE);
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

async function dbGet(key){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readonly');
    const request=tx.objectStore(DB_STORE).get(key);
    request.onsuccess=()=>resolve(request.result??null);
    request.onerror=()=>reject(request.error);
    tx.oncomplete=()=>db.close();
  });
}

async function dbPut(key,value){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readwrite');
    tx.objectStore(DB_STORE).put(value,key);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
    tx.onabort=()=>{db.close();reject(tx.error);};
  });
}

async function dbDelete(key){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(DB_STORE,'readwrite');
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete=()=>{db.close();resolve();};
    tx.onerror=()=>{db.close();reject(tx.error);};
  });
}

async function saveSession(access){
  await dbPut('active-session',{savedAt:new Date().toISOString(),access});
}

async function saveSnapshotAtomic(snapshot){
  const payload={schema:1,savedAt:new Date().toISOString(),snapshot};
  validateSnapshot(snapshot,activeAccess);
  await dbPut('snapshot-pending',payload);
  const verify=await dbGet('snapshot-pending');
  validateSnapshot(verify?.snapshot,activeAccess);
  await dbPut('active-snapshot',verify);
  await dbDelete('snapshot-pending');
}

async function loadSnapshot(access){
  try{
    const stored=await dbGet('active-snapshot');
    if(!stored?.snapshot)return null;
    return validateSnapshot(stored.snapshot,access);
  }catch(_){return null;}
}

async function loadStoredSession(){
  try{
    const stored=await dbGet('active-session');
    const access=stored?.access;
    if(!access?.sessionToken||!access?.expiresAt)return null;
    if(new Date(access.expiresAt).getTime()<=Date.now())return null;
    return access;
  }catch(_){return null;}
}

async function clearStoredState(){
  try{
    await dbDelete('active-session');
    await dbDelete('active-snapshot');
    await dbDelete('snapshot-pending');
  }catch(_){ }
}

async function registerServiceWorker(){
  if('serviceWorker' in navigator){
    try{await navigator.serviceWorker.register('./service-worker.js');}catch(_){ }
  }
  if(navigator.storage?.persist){
    try{await navigator.storage.persist();}catch(_){ }
  }
}

async function startup(){
  initialiseUi();
  initialiseMapInteractions();
  await registerServiceWorker();

  const url=new URL(window.location.href);
  const linked=normaliseAccessCode(url.searchParams.get('code'));
  if(linked){
    $('accessCode').value=linked;
    $('accessForm').requestSubmit();
    return;
  }

  const stored=await loadStoredSession();
  if(stored){
    try{
      await openAccess(stored);
      return;
    }catch(_){
      await clearStoredState();
    }
  }

  setScreen(false);
}

startup();
