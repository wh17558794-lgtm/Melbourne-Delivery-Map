(function(){
  'use strict';

  const LOCAL_AREA_URL='data/delivery-areas.geojson';
  const LOCAL_SUBURB_URL='data/suburb-boundaries.geojson';
  const KEY_STORAGE='melbourne-delivery-google-maps-key';
  const legacyCode=document.getElementById('legacyLeafletCode')?.textContent||'';

  function legacyJson(name){
    const match=legacyCode.match(new RegExp(`const\\s+${name}=([^;]+);`));
    if(!match) throw new Error(`Missing legacy configuration: ${name}`);
    return JSON.parse(match[1]);
  }

  const zoneByPostcode=legacyJson('zoneByPostcode');
  const postcodeBatches=legacyJson('postcodeBatches');
  const localityZones={'ELTHAM':'Standard','ELTHAM NORTH':'Standard','RESEARCH':'Additional charge'};
  const staticMode=new URLSearchParams(location.search).has('static');
  const roadIconMode=new URLSearchParams(location.search).get('road-icons')||'default';
  const cloudMapId=String(window.GOOGLE_MAPS_MAP_ID||'').trim();

  const statusElement=document.getElementById('status');
  const searchPanel=document.getElementById('searchPanel');
  const panelToggle=document.getElementById('panelToggle');
  const searchInput=document.getElementById('searchInput');
  const inputCount=document.getElementById('inputCount');
  const searchButton=document.getElementById('searchButton');
  const clearButton=document.getElementById('clearButton');
  const boundaryToggleButton=document.getElementById('boundaryToggleButton');
  const boundaryToggleLabel=document.getElementById('boundaryToggleLabel');
  const suburbTagToggleButton=document.getElementById('suburbTagToggleButton');
  const suburbTagToggleLabel=document.getElementById('suburbTagToggleLabel');
  const resultMarkButton=document.getElementById('resultMarkButton');
  const resultMarkLabel=document.getElementById('resultMarkLabel');
  const sheetImportButton=document.getElementById('sheetImportButton');
  const sheetImportLabel=document.getElementById('sheetImportLabel');
  const searchResults=document.getElementById('searchResults');
  const searchProgress=document.getElementById('searchProgress');
  const searchProgressBar=searchProgress.querySelector('span');
  const legendElement=document.getElementById('legend');

  const selectedSuburbs=new Map();
  const suburbFeatures=new Map();
  const suburbZoneByName=new Map();
  const sessionGeocodeCache=new Map();
  const addressMarkers=[];
  const postcodeLabels=[];

  let map=null;
  let geocoder=null;
  let infoWindow=null;
  let AdvancedMarkerElement=null;
  let markerProjection=null;
  let defaultData=null;
  let suburbData=null;
  let defaultBounds=null;
  let suburbLoadPromise=null;
  let searchActive=false;
  let boundariesVisible=false;
  let suburbTagsVisible=false;
  let infoOpen=false;
  let sheetsTokenClient=null;
  let sheetsAccessToken='';
  let sheetsTokenResolve=null;
  let sheetsTokenReject=null;

  const SHEETS_READ_SCOPE='https://www.googleapis.com/auth/spreadsheets.readonly';

  searchButton.disabled=true;
  clearButton.disabled=true;
  if(boundaryToggleButton) boundaryToggleButton.disabled=true;
  if(staticMode) document.body.classList.add('static-map');

  function updateInputCount(){
    const count=searchInput.value.split(/\r?\n/).filter(line=>line.trim()).length;
    inputCount.textContent=`${count} 条`;
  }

  function sheetImportConfig(){
    const raw=window.GOOGLE_SHEETS_IMPORT_CONFIG||{};
    const spreadsheetInput=String(raw.spreadsheetId||'').trim();
    const urlMatch=spreadsheetInput.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return {
      oauthClientId:String(raw.oauthClientId||'').trim(),
      spreadsheetId:urlMatch?.[1]||spreadsheetInput,
      range:String(raw.range||'').trim()
    };
  }

  function missingSheetImportConfig(config){
    const missing=[];
    if(!config.oauthClientId) missing.push('Google OAuth Client ID');
    if(!config.spreadsheetId) missing.push('Google Sheet 链接或 Spreadsheet ID');
    if(!config.range) missing.push('页签和地址范围');
    return missing;
  }

  function waitForGoogleIdentityServices(timeoutMs=8000){
    if(window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const started=Date.now();
      const timer=setInterval(()=>{
        if(window.google?.accounts?.oauth2){
          clearInterval(timer);
          resolve();
        }else if(Date.now()-started>=timeoutMs){
          clearInterval(timer);
          reject(new Error('Google 登录组件加载失败，请检查网络后刷新页面。'));
        }
      },100);
    });
  }

  function initialiseSheetsTokenClient(config){
    if(sheetsTokenClient) return sheetsTokenClient;
    sheetsTokenClient=google.accounts.oauth2.initTokenClient({
      client_id:config.oauthClientId,
      scope:SHEETS_READ_SCOPE,
      callback:response=>{
        if(response?.access_token){
          sheetsAccessToken=response.access_token;
          sheetsTokenResolve?.(response.access_token);
        }else{
          sheetsTokenReject?.(new Error(response?.error_description||response?.error||'Google 授权未完成。'));
        }
        sheetsTokenResolve=null;
        sheetsTokenReject=null;
      },
      error_callback:error=>{
        sheetsTokenReject?.(new Error(error?.message||error?.type||'Google 登录窗口已关闭。'));
        sheetsTokenResolve=null;
        sheetsTokenReject=null;
      }
    });
    return sheetsTokenClient;
  }

  function requestSheetsAccessToken(config){
    if(sheetsAccessToken) return Promise.resolve(sheetsAccessToken);
    return new Promise((resolve,reject)=>{
      sheetsTokenResolve=resolve;
      sheetsTokenReject=reject;
      initialiseSheetsTokenClient(config).requestAccessToken();
    });
  }

  async function fetchSheetAddresses(config,accessToken){
    const url='https://sheets.googleapis.com/v4/spreadsheets/'+
      `${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(config.range)}?`+
      new URLSearchParams({majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'});
    const response=await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});
    let payload={};
    try{
      payload=await response.json();
    }catch(_error){
      // The status below still produces a useful message for a non-JSON response.
    }
    if(!response.ok){
      if(response.status===401) sheetsAccessToken='';
      const detail=payload?.error?.message||`Google Sheets returned HTTP ${response.status}`;
      throw new Error(detail);
    }
    return (payload.values||[])
      .map(row=>String(row?.[0]??'').trim())
      .filter(Boolean);
  }

  function setSheetImportBusy(busy){
    if(!sheetImportButton||!sheetImportLabel) return;
    sheetImportButton.disabled=busy;
    sheetImportLabel.textContent=busy?'正在连接 Google Sheets...':'从 Google Sheets 导入';
  }

  async function importAddressesFromGoogleSheets(){
    const config=sheetImportConfig();
    const missing=missingSheetImportConfig(config);
    if(missing.length){
      setSearchResult(
        `<b>Google Sheets 导入尚未配置。</b><br>还需要：${escapeHtml(missing.join('、'))}。`,
        [],
        true
      );
      return;
    }
    if(searchInput.value.trim()&&!window.confirm('导入会替换地址框内的现有内容，是否继续？')) return;

    setSheetImportBusy(true);
    setSearchResult('正在请求只读权限并读取 Google Sheet...');
    try{
      await waitForGoogleIdentityServices();
      const accessToken=await requestSheetsAccessToken(config);
      const addresses=await fetchSheetAddresses(config,accessToken);
      if(!addresses.length) throw new Error(`指定范围 ${config.range} 中没有可导入的地址。`);
      searchInput.value=addresses.join('\n');
      searchInput.dispatchEvent(new Event('input',{bubbles:true}));
      sheetImportButton?.classList.add('connected');
      setSearchResult(
        `<b>已从 Google Sheets 导入 ${addresses.length} 条地址。</b><br>`+
        `来源：${escapeHtml(config.range)}。请检查地址后点击“查找并显示”。`
      );
      searchInput.focus();
    }catch(error){
      console.error(error);
      setSearchResult(`Google Sheets 导入失败：${escapeHtml(error.message||'Unknown error')}`,[],true);
    }finally{
      setSheetImportBusy(false);
    }
  }

  function normaliseText(value){
    return String(value||'')
      .toUpperCase()
      .replace(/[’‘]/g,"'")
      .replace(/[–—]/g,'-')
      .replace(/[.,;，；、:：()[\]]+/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function normaliseSuburbInput(value){
    return normaliseText(value)
      .replace(/\b(?:AUSTRALIA|VICTORIA|VIC)\b/g,' ')
      .replace(/\b\d{4}\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function escapeHtml(value){
    return String(value)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  function roadIconStyles(){
    if(roadIconMode==='major'){
      return [
        {featureType:'road.arterial',elementType:'labels.icon',stylers:[{visibility:'off'}]},
        {featureType:'road.local',elementType:'labels.icon',stylers:[{visibility:'off'}]}
      ];
    }
    if(roadIconMode==='custom'){
      return [{featureType:'road',elementType:'labels.icon',stylers:[{visibility:'off'}]}];
    }
    return [];
  }

  function googleMapOptions(){
    const options={
      center:{lat:-37.8136,lng:144.9631},
      zoom:10,
      mapTypeControl:false,
      streetViewControl:false,
      fullscreenControl:true,
      gestureHandling:'greedy'
    };

    if(roadIconMode==='major'){
      // Retain the old comparison mode. Embedded JSON styles are raster-only.
      options.renderingType=google.maps.RenderingType.RASTER;
      options.isFractionalZoomEnabled=false;
      options.styles=roadIconStyles();
      return options;
    }

    // The default map and option 2 both stay vector-based. This restores the
    // normal fractional mouse-wheel zoom and keeps labels/roads crisp.
    options.renderingType=google.maps.RenderingType.VECTOR;
    options.isFractionalZoomEnabled=true;

    if(roadIconMode==='custom'&&cloudMapId){
      // Road shields and POI icons are controlled by the cloud style attached
      // to this Map ID. Do not also pass the raster-only `styles` option.
      options.mapId=cloudMapId;
    }

    return options;
  }

  async function loadLocalGeoJson(url,label){
    const response=await fetch(url,{cache:'default'});
    if(!response.ok){
      throw new Error(`${label}文件不存在（${response.status}）。请先运行 build-local-boundaries.cmd。`);
    }
    const data=await response.json();
    if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)){
      throw new Error(`${label}文件格式不正确。请重新生成本地边界。`);
    }
    return data;
  }

  function loadAreas(){
    return loadLocalGeoJson(LOCAL_AREA_URL,'配送边界');
  }

  function loadSuburbBoundaries(){
    if(!suburbLoadPromise){
      suburbLoadPromise=loadLocalGeoJson(LOCAL_SUBURB_URL,'Suburb 边界')
        .then(data=>{
          registerSuburbGeoJson(data);
          return data;
        })
        .catch(error=>{
          suburbLoadPromise=null;
          throw error;
        });
    }
    return suburbLoadPromise;
  }

  function boundaryWeight(){
    const zoom=map?.getZoom()||10;
    if(zoom>=16) return 2.2;
    if(zoom>=14) return 1.8;
    if(zoom>=12) return 1.45;
    return 1.15;
  }

  function suburbBoundaryWeight(){
    const zoom=map?.getZoom()||10;
    if(zoom>=16) return 2;
    if(zoom>=14) return 1.6;
    if(zoom>=12) return 1.3;
    return 1;
  }

  function defaultFeatureStyle(feature){
    return {
      clickable:true,
      visible:!searchActive,
      strokeColor:'#475467',
      strokeOpacity:.78,
      strokeWeight:boundaryWeight(),
      fillColor:'#FFFFFF',
      fillOpacity:.04
    };
  }

  function suburbFeatureStyle(feature){
    const name=normaliseText(feature.getProperty('locality_name'));
    const selection=selectedSuburbs.get(name);
    const marked=suburbHasMarkedResult(name);
    const showAll=!searchActive;
    return {
      clickable:showAll||Boolean(selection),
      visible:showAll||Boolean(selection),
      strokeColor:selection?(marked?'#175CD3':'#A66B00'):'#475467',
      strokeOpacity:showAll||selection ? .9 : 0,
      strokeWeight:suburbBoundaryWeight(),
      fillColor:selection?(marked?'#38BDF8':'#F2B134'):'#FFFFFF',
      fillOpacity:selection ? .32 : .04
    };
  }

  function closeInfo(){
    infoWindow?.close();
    infoOpen=false;
  }

  function openInfo(position,html){
    if(infoOpen){
      closeInfo();
      return;
    }
    infoWindow.setContent(html);
    infoWindow.setPosition(position);
    infoWindow.open({map});
    infoOpen=true;
  }

  function geometryBounds(geometry,bounds=new google.maps.LatLngBounds()){
    geometry?.forEachLatLng(latLng=>bounds.extend(latLng));
    return bounds;
  }

  function setupDefaultLayer(areas){
    defaultData=new google.maps.Data({map});
    const features=defaultData.addGeoJson(areas);
    defaultData.setStyle(defaultFeatureStyle);
    defaultData.addListener('click',event=>{
      const postcode=event.feature.getProperty('postcode');
      const suburb=event.feature.getProperty('suburb');
      const zone=event.feature.getProperty('zone');
      openInfo(
        event.latLng,
        `<b>Postcode ${escapeHtml(postcode)}</b>${suburb?`<br>${escapeHtml(suburb)}`:''}<br>${escapeHtml(zone)}`
      );
    });
    defaultData.addListener('mouseover',event=>{
      defaultData.overrideStyle(event.feature,{fillOpacity:.64,strokeColor:'#344054'});
    });
    defaultData.addListener('mouseout',event=>defaultData.revertStyle(event.feature));

    defaultBounds=new google.maps.LatLngBounds();
    features.forEach(feature=>geometryBounds(feature.getGeometry(),defaultBounds));
    createPostcodeLabels(features);
  }

  function createPostcodeLabels(features){
    const seen=new Set();
    features.forEach(feature=>{
      const postcode=String(feature.getProperty('postcode')||'');
      const suburb=feature.getProperty('suburb');
      const showLabel=feature.getProperty('showLabel');
      if(!postcode||seen.has(postcode)||(suburb&&!showLabel)) return;
      seen.add(postcode);
      const bounds=geometryBounds(feature.getGeometry());
      if(bounds.isEmpty()) return;
      const marker=new google.maps.Marker({
        position:bounds.getCenter(),
        map:null,
        clickable:false,
        optimized:false,
        zIndex:4,
        icon:{path:google.maps.SymbolPath.CIRCLE,scale:0},
        label:{text:postcode,color:'#ffffff',fontSize:'10px',fontWeight:'700',className:'postcode-label'}
      });
      postcodeLabels.push(marker);
    });
    updatePostcodeLabels();
  }

  function updatePostcodeLabels(){
    const show=!searchActive&&(staticMode||(map?.getZoom()||0)>=12);
    postcodeLabels.forEach(marker=>marker.setMap(show?map:null));
  }

  function ensureSuburbLayer(){
    if(suburbData) return;
    suburbData=new google.maps.Data();
    suburbData.setStyle(suburbFeatureStyle);
    suburbData.addListener('click',event=>{
      const name=normaliseText(event.feature.getProperty('locality_name'));
      openInfo(event.latLng,`<b>${escapeHtml(name)}</b>`);
    });
    suburbData.addListener('mouseover',event=>{
      const name=normaliseText(event.feature.getProperty('locality_name'));
      if(!searchActive||selectedSuburbs.has(name)){
        const marked=suburbHasMarkedResult(name);
        suburbData.overrideStyle(event.feature,{
          fillOpacity:searchActive ? .45 : .12,
          strokeColor:searchActive?(marked?'#0C4A6E':'#7A4E00'):'#344054'
        });
      }
    });
    suburbData.addListener('mouseout',event=>suburbData.revertStyle(event.feature));
  }

  function registerSuburbGeoJson(data){
    ensureSuburbLayer();
    const added=suburbData.addGeoJson(data);
    if(!defaultBounds) defaultBounds=new google.maps.LatLngBounds();
    added.forEach(feature=>{
      const name=normaliseText(feature.getProperty('locality_name'));
      if(!suburbFeatures.has(name)) suburbFeatures.set(name,[]);
      suburbFeatures.get(name).push(feature);
      const zone=feature.getProperty('zone');
      if(zone) suburbZoneByName.set(name,zone);
      geometryBounds(feature.getGeometry(),defaultBounds);
    });
    return added;
  }

  async function ensureSuburbBoundaries(rawNames=[]){
    await loadSuburbBoundaries();
  }

  async function ensureSpecificSuburb(rawName){
    const requested=normaliseSuburbInput(rawName);
    if(suburbFeatures.has(requested)) return requested;
    const partial=[...suburbFeatures.keys()].filter(name=>name.includes(requested)||requested.includes(name));
    if(partial.length===1) return partial[0];
    return null;
  }

  async function getSuburbZone(name){
    if(localityZones[name]) return localityZones[name];
    return suburbZoneByName.get(name)||'Outside delivery area';
  }

  function cleanAddress(value){
    let address=String(value||'')
      .replace(/[，；]/g,',')
      .replace(/[–—]/g,'-')
      .trim();
    address=address
      .replace(/^(?:UNIT|APT|APARTMENT|SHOP|SUITE|FLAT)\s+[A-Z0-9-]+(?:\s*\([^)]*\))?\s*,?\s*/i,'')
      .replace(/^U\s*[A-Z0-9-]+\s*,?\s*/i,'')
      .replace(/^[A-Z]*\d+[A-Z-]*\s*\/\s*(?=\d)/i,'')
      .replace(/^LEVEL\s+[A-Z0-9-]+\s*,?\s*/i,'')
      .replace(/^(?:LOT\s+[A-Z0-9-]+\s*,?\s*)+/i,'')
      .replace(/\s+/g,' ')
      .trim();
    return address;
  }

  function isAddressInput(value){
    const query=normaliseText(value);
    return /^(?:(?:UNIT|SHOP|APT|APARTMENT|SUITE|FLAT|LEVEL)\b|U\s*\d|[A-Z]*\d)/.test(query);
  }

  function addressComponent(result,type){
    return result.address_components?.find(component=>component.types.includes(type))?.long_name||'';
  }

  function fallbackSuburb(input){
    const withoutState=cleanAddress(input)
      .replace(/\b(?:AUSTRALIA|VICTORIA|VIC)\b/ig,' ')
      .replace(/\b3\d{3}\b/g,' ')
      .replace(/\s+/g,' ')
      .trim();
    const commaParts=withoutState.split(',').map(part=>part.trim()).filter(Boolean);
    return commaParts.length>1?commaParts.at(-1):'';
  }

  async function geocodeAddress(input){
    const cleaned=cleanAddress(input);
    const key=normaliseText(cleaned);
    if(sessionGeocodeCache.has(key)) return sessionGeocodeCache.get(key);
    const requestAddress=/\b(?:VIC|VICTORIA|AUSTRALIA)\b/i.test(cleaned)
      ?cleaned
      :`${cleaned}, Victoria, Australia`;
    const response=await geocoder.geocode({
      address:requestAddress,
      componentRestrictions:{country:'AU'},
      region:'au'
    });
    const candidates=(response.results||[]).filter(result=>{
      const postcode=addressComponent(result,'postal_code');
      const state=addressComponent(result,'administrative_area_level_1');
      return (!postcode||/^3\d{3}$/.test(postcode))&&(!state||/Victoria|VIC/i.test(state));
    });
    const result=candidates[0]||response.results?.[0];
    if(!result) return null;
    const postcode=addressComponent(result,'postal_code');
    const locality=addressComponent(result,'locality')||
      addressComponent(result,'postal_town')||
      addressComponent(result,'sublocality_level_1')||
      fallbackSuburb(input);
    const match={
      feature:{
        type:'Feature',
        properties:{
          ezi_address:result.formatted_address,
          locality_name:normaliseText(locality),
          postcode:String(postcode||'')
        },
        geometry:{
          type:'Point',
          coordinates:[result.geometry.location.lng(),result.geometry.location.lat()]
        }
      },
      ambiguous:false
    };
    sessionGeocodeCache.set(key,match);
    return match;
  }

  async function mapWithConcurrency(items,limit,worker,onProgress){
    const results=new Array(items.length);
    let nextIndex=0;
    let completed=0;
    async function run(){
      while(nextIndex<items.length){
        const index=nextIndex++;
        try{
          results[index]=await worker(items[index],index);
        }catch(error){
          results[index]={ok:false,input:items[index],reason:error.message||'Search failed'};
        }
        completed++;
        onProgress?.(completed,items.length);
      }
    }
    await Promise.all(Array.from({length:Math.min(limit,items.length)},run));
    return results;
  }

  async function geocodeAddressesBatch(items){
    const matches=new Map();
    await mapWithConcurrency(items,5,async item=>{
      try{
        matches.set(item.index,{match:await geocodeAddress(item.input)});
      }catch(error){
        matches.set(item.index,{error});
      }
    });
    return matches;
  }

  function mergeSuburbSelection(name,zone,lineNumber){
    const existing=selectedSuburbs.get(name);
    if(!existing){
      selectedSuburbs.set(name,{zone,lineNumbers:[lineNumber]});
      return;
    }
    existing.lineNumbers.push(lineNumber);
    if(existing.zone!==zone&&zone!=='Outside delivery area'&&existing.zone!=='Outside delivery area'){
      existing.zone='Mixed';
    }else if(existing.zone==='Outside delivery area'&&zone!=='Outside delivery area'){
      existing.zone=zone;
    }
  }

  function markerIcon(){
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40"><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#FFFFFF" stroke-width="3.2"/><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#B3261E" stroke-width="1.2"/><circle cx="14" cy="14" r="5.5" fill="#B3261E"/></svg>`;
    return {
      url:`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      scaledSize:new google.maps.Size(21,30),
      anchor:new google.maps.Point(10.5,30)
    };
  }

  function addressMarkerHtml(){
    const element=document.createElement('div');
    element.className='delivery-address-pin';
    element.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40" aria-hidden="true"><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#FFFFFF" stroke-width="3.2"/><path d="M14 1C6.82 1 1 6.82 1 14c0 10.18 13 25 13 25s13-14.82 13-25C27 6.82 21.18 1 14 1Z" fill="#EA4335" stroke="#B3261E" stroke-width="1.2"/><circle cx="14" cy="14" r="5.5" fill="#B3261E"/></svg>';
    return element;
  }

  function suburbLabelHtml(name){
    const element=document.createElement('div');
    element.className='delivery-suburb-label';
    element.textContent=name;
    return element;
  }

  const labelAnchors={
    right:{left:'14px',top:'-28px'},
    top:{left:'-50%',top:'calc(-100% - 36px)'},
    left:{left:'calc(-100% - 14px)',top:'-28px'},
    bottom:{left:'-50%',top:'8px'}
  };

  function setAddressLabelPlacement(record,placement){
    const anchor=labelAnchors[placement]||labelAnchors.right;
    record.placement=placement;
    record.label.anchorLeft=anchor.left;
    record.label.anchorTop=anchor.top;
  }

  function labelCandidateBox(point,width,height,placement){
    if(placement==='top') return {left:point.x-width/2,top:point.y-height-36,right:point.x+width/2,bottom:point.y-36};
    if(placement==='left') return {left:point.x-width-14,top:point.y-28,right:point.x-14,bottom:point.y-28+height};
    if(placement==='bottom') return {left:point.x-width/2,top:point.y+8,right:point.x+width/2,bottom:point.y+8+height};
    return {left:point.x+14,top:point.y-28,right:point.x+14+width,bottom:point.y-28+height};
  }

  function boxesOverlap(a,b,padding=5){
    return !(a.right+padding<=b.left||a.left>=b.right+padding||a.bottom+padding<=b.top||a.top>=b.bottom+padding);
  }

  function layoutAddressLabels(){
    if(!map||!markerProjection) return;
    const projection=markerProjection.getProjection();
    if(!projection) return;
    const zoom=map.getZoom()||0;
    const records=addressMarkers.filter(record=>record.kind==='advanced');
    if(!suburbTagsVisible){
      records.forEach(record=>{record.label.map=null});
      return;
    }
    const showLabels=zoom>=10;
    const mapDiv=map.getDiv();
    const mapWidth=mapDiv.clientWidth;
    const mapHeight=mapDiv.clientHeight;
    const points=new Map();
    records.forEach(record=>points.set(record,projection.fromLatLngToContainerPixel(new google.maps.LatLng(record.position))));
    const pinBoxes=records.map(record=>{
      const point=points.get(record);
      return {record,left:point.x-13,top:point.y-34,right:point.x+13,bottom:point.y+4};
    });
    const occupied=[];

    records.forEach((record,index)=>{
      record.labelElement.classList.toggle('is-detailed',zoom>=14);
      if(!showLabels&&!record.hovering){
        record.label.map=null;
        return;
      }
      const point=points.get(record);
      const width=Math.min(190,Math.max(74,24+String(record.suburb).length*(zoom>=14?7.4:6.9)));
      const height=zoom>=14?28:26;
      let directions=['right','top','left','bottom'];
      if(point.x>mapWidth*.72) directions=['left','top','bottom','right'];
      else if(point.x<mapWidth*.28) directions=['right','top','bottom','left'];
      else if(index%2) directions=['top','right','left','bottom'];
      let chosen=null;
      for(const direction of directions){
        const box=labelCandidateBox(point,width,height,direction);
        const within=box.left>=8&&box.top>=8&&box.right<=mapWidth-8&&box.bottom<=mapHeight-8;
        const hitsLabel=occupied.some(other=>boxesOverlap(box,other));
        const hitsPin=pinBoxes.some(other=>other.record!==record&&boxesOverlap(box,other,2));
        if(within&&!hitsLabel&&!hitsPin){
          chosen={direction,box};
          break;
        }
      }
      if(!chosen&&!record.hovering){
        record.label.map=null;
        return;
      }
      setAddressLabelPlacement(record,chosen?.direction||record.placement||'right');
      record.label.map=map;
      if(chosen) occupied.push(chosen.box);
    });
  }

  function updateSuburbTagToggle(){
    if(!suburbTagToggleButton||!suburbTagToggleLabel) return;
    const available=addressMarkers.some(item=>item.kind==='advanced');
    const active=available&&suburbTagsVisible;
    suburbTagToggleButton.disabled=!available;
    suburbTagToggleButton.classList.toggle('active',active);
    suburbTagToggleButton.setAttribute('aria-pressed',String(active));
    suburbTagToggleLabel.textContent=active?'隐藏 Suburb 名称':'显示 Suburb 名称';
  }

  function setSuburbTagsVisible(visible){
    suburbTagsVisible=Boolean(visible);
    if(!suburbTagsVisible){
      addressMarkers.forEach(item=>{
        if(item.kind==='advanced') item.label.map=null;
      });
    }
    updateSuburbTagToggle();
    requestAnimationFrame(layoutAddressLabels);
  }

  function suburbHasMarkedResult(name){
    const suburbKey=normaliseText(name);
    return addressMarkers.some(item=>item.kind==='advanced'&&item.marked&&item.suburbKey===suburbKey);
  }

  function updateAddressRecordAppearance(record){
    if(record.kind!=='advanced') return;
    record.pinElement.classList.toggle('is-marked',record.marked);
    record.labelElement.classList.toggle('is-marked',record.marked);
    record.pinElement.classList.toggle('is-pending',record.pending);
    record.labelElement.classList.toggle('is-pending',record.pending);
  }

  function pendingAddressRecords(){
    return addressMarkers.filter(item=>item.kind==='advanced'&&item.pending);
  }

  function updateResultMarkButton(){
    if(!resultMarkButton||!resultMarkLabel) return;
    const pending=pendingAddressRecords();
    const unmark=pending.length>0&&pending.every(item=>item.marked);
    resultMarkButton.disabled=pending.length===0;
    resultMarkButton.classList.toggle('ready',pending.length>0);
    resultMarkLabel.textContent=pending.length
      ?`${unmark?'取消标记':'标记选中结果'} (${pending.length})`
      :'标记选中结果';
  }

  function toggleAddressRecordSelection(record){
    record.pending=!record.pending;
    updateAddressRecordAppearance(record);
    updateResultMarkButton();
  }

  function applyPendingAddressMarks(){
    const pending=pendingAddressRecords();
    if(!pending.length) return;
    const shouldMark=pending.some(item=>!item.marked);
    pending.forEach(record=>{
      record.marked=shouldMark;
      record.pending=false;
      updateAddressRecordAppearance(record);
    });
    updateResultMarkButton();
    suburbData?.setStyle(suburbFeatureStyle);
    updateLegend();
    requestAnimationFrame(layoutAddressLabels);
  }

  function addAddressMarker(result){
    const [longitude,latitude]=result.feature.geometry.coordinates;
    const props=result.feature.properties;
    const position={lat:latitude,lng:longitude};

    if(AdvancedMarkerElement){
      const pinElement=addressMarkerHtml();
      const labelElement=suburbLabelHtml(props.locality_name);
      const marker=new AdvancedMarkerElement({
        position,
        map,
        content:pinElement,
        title:`${result.lineNumber}. ${props.ezi_address}`,
        zIndex:1000-result.lineNumber,
        gmpClickable:true,
        collisionBehavior:google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
      });
      const label=new AdvancedMarkerElement({
        position,
        map:null,
        content:labelElement,
        title:props.locality_name,
        zIndex:900-result.lineNumber,
        gmpClickable:true,
        collisionBehavior:google.maps.CollisionBehavior.REQUIRED_AND_HIDES_OPTIONAL
      });
      const record={
        kind:'advanced',
        marker,
        label,
        pinElement,
        labelElement,
        position,
        suburb:props.locality_name,
        suburbKey:normaliseText(props.locality_name),
        placement:'right',
        hovering:false,
        pending:false,
        marked:false
      };
      setAddressLabelPlacement(record,'right');
      const showInfo=()=>openInfo(
        position,
        `<b>${result.lineNumber}. ${escapeHtml(props.ezi_address)}</b><br>`+
        `${escapeHtml(props.locality_name)} · ${escapeHtml(props.postcode||'No postcode')}<br>`
      );
      const handleResultClick=event=>{
        event.preventDefault();
        event.stopPropagation();
        if(event.ctrlKey||event.metaKey){
          closeInfo();
          toggleAddressRecordSelection(record);
          return;
        }
        showInfo();
      };
      pinElement.addEventListener('click',handleResultClick);
      labelElement.addEventListener('click',handleResultClick);
      const setHovering=value=>{
        record.hovering=value;
        layoutAddressLabels();
      };
      pinElement.addEventListener('mouseenter',()=>setHovering(true));
      pinElement.addEventListener('mouseleave',()=>setHovering(false));
      labelElement.addEventListener('mouseenter',()=>setHovering(true));
      labelElement.addEventListener('mouseleave',()=>setHovering(false));
      updateAddressRecordAppearance(record);
      addressMarkers.push(record);
      updateResultMarkButton();
      requestAnimationFrame(layoutAddressLabels);
      return;
    }

    const marker=new google.maps.Marker({
      position,
      map,
      zIndex:20,
      icon:markerIcon(),
      title:`${result.lineNumber}. ${props.ezi_address}`
    });
    marker.addListener('click',()=>openInfo(
      marker.getPosition(),
      `<b>${result.lineNumber}. ${escapeHtml(props.ezi_address)}</b><br>`+
      `${escapeHtml(props.locality_name)} · ${escapeHtml(props.postcode||'No postcode')}<br>`+
      ''
    ));
    addressMarkers.push(marker);
  }

  function clearAddressMarkers(){
    addressMarkers.splice(0).forEach(item=>{
      if(item.kind==='advanced'){
        item.marker.map=null;
        item.label.map=null;
      }else{
        item.setMap(null);
      }
    });
    updateResultMarkButton();
  }

  function updateAddressMarkerSizes(){
    addressMarkers.forEach(item=>{
      if(item.kind!=='advanced') item.setIcon(markerIcon());
    });
    requestAnimationFrame(layoutAddressLabels);
  }

  function updateSearchProgress(completed,total){
    searchProgress.hidden=false;
    searchProgressBar.style.width=`${Math.round(completed/total*100)}%`;
  }

  function setSearchResult(message,errors=[],isError=false){
    searchResults.classList.toggle('error',isError);
    searchResults.classList.add('visible');
    searchResults.innerHTML=message;
    if(errors.length){
      const list=document.createElement('ul');
      list.className='result-errors';
      errors.forEach(error=>{
        const item=document.createElement('li');
        item.textContent=error;
        list.appendChild(item);
      });
      searchResults.appendChild(list);
    }
  }

  function updateLegend(){
    legendElement.hidden=false;
    if(searchActive){
      const hasMarked=addressMarkers.some(item=>item.kind==='advanced'&&item.marked);
      legendElement.innerHTML=
        '<span class="sw" style="background:#F2B134"></span>Selected suburb&nbsp;&nbsp;'+
        '<span class="sw" style="background:#EA4335;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span>Address'+
        (hasMarked?'&nbsp;&nbsp;<span class="sw" style="background:#38BDF8"></span>Marked suburb&nbsp;&nbsp;<span class="sw" style="background:#2F80ED;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span>Marked address':'');
    }else if(boundariesVisible){
      legendElement.innerHTML=
        '<span class="sw" style="background:#FFFFFF;border:1px solid #475467"></span>Suburb boundary';
    }else{
      legendElement.innerHTML='';
      legendElement.hidden=true;
    }
  }

  function updateBoundaryToggle(){
    if(!boundaryToggleButton||!boundaryToggleLabel) return;
    const total=suburbFeatures.size||650;
    boundaryToggleButton.disabled=!suburbData||searchActive;
    boundaryToggleButton.classList.toggle('active',boundariesVisible);
    boundaryToggleButton.setAttribute('aria-pressed',String(boundariesVisible));
    boundaryToggleLabel.textContent=`${boundariesVisible?'隐藏':'显示'}${total}个 Suburb 边界`;
  }

  function setAllBoundariesVisible(visible){
    boundariesVisible=Boolean(visible)&&!searchActive;
    if(suburbData){
      suburbData.setMap(boundariesVisible?map:null);
      suburbData.setStyle(suburbFeatureStyle);
    }
    if(!boundariesVisible) closeInfo();
    updateBoundaryToggle();
    updateLegend();
  }

  function showSearchMode(){
    searchActive=true;
    boundariesVisible=false;
    defaultData?.setMap(null);
    suburbData?.setMap(map);
    suburbData?.setStyle(suburbFeatureStyle);
    updatePostcodeLabels();
    updateBoundaryToggle();
    updateLegend();
  }

  function fitSearchResults(){
    const bounds=new google.maps.LatLngBounds();
    addressMarkers.forEach(item=>bounds.extend(item.kind==='advanced'?item.position:item.getPosition()));
    selectedSuburbs.forEach((_,name)=>{
      (suburbFeatures.get(name)||[]).forEach(feature=>geometryBounds(feature.getGeometry(),bounds));
    });
    if(bounds.isEmpty()) return;
    map.fitBounds(bounds,48);
    google.maps.event.addListenerOnce(map,'idle',()=>{
      if(map.getZoom()>15) map.setZoom(15);
    });
  }

  function resetSearch(clearInput=true){
    selectedSuburbs.clear();
    clearAddressMarkers();
    setSuburbTagsVisible(false);
    searchActive=false;
    boundariesVisible=false;
    defaultData?.setMap(null);
    suburbData?.setMap(null);
    suburbData?.setStyle(suburbFeatureStyle);
    if(clearInput){
      searchInput.value='';
      updateInputCount();
    }
    searchResults.className='search-results';
    searchResults.textContent='';
    searchProgress.hidden=true;
    searchProgressBar.style.width='0';
    closeInfo();
    updatePostcodeLabels();
    updateBoundaryToggle();
    updateLegend();
    if(defaultBounds&&!defaultBounds.isEmpty()) map.fitBounds(defaultBounds,35);
  }

  async function runBatchSearch(){
    const lines=searchInput.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    if(!lines.length){
      setSearchResult('请先输入至少一个地址或 suburb。',[],true);
      return;
    }

    if(boundariesVisible) setAllBoundariesVisible(false);
    setSuburbTagsVisible(false);
    if(suburbTagToggleButton) suburbTagToggleButton.disabled=true;

    searchButton.disabled=true;
    clearButton.disabled=true;
    if(boundaryToggleButton) boundaryToggleButton.disabled=true;
    searchProgressBar.style.width='0';
    searchProgress.hidden=false;
    setSearchResult(`正在使用 Google 定位 ${lines.length} 条信息...`);

    try{
      selectedSuburbs.clear();
      clearAddressMarkers();
      const addressItems=lines.map((input,index)=>({input,index})).filter(item=>isAddressInput(item.input));
      const directSuburbNames=lines.filter(input=>!isAddressInput(input)).map(normaliseSuburbInput);
      const directBoundaryRequest=ensureSuburbBoundaries(directSuburbNames);
      const addressMatches=await geocodeAddressesBatch(addressItems);
      const addressSuburbNames=[...addressMatches.values()]
        .map(result=>result.match?.feature?.properties?.locality_name)
        .filter(Boolean);
      await directBoundaryRequest;
      await ensureSuburbBoundaries(addressSuburbNames);

      const results=await mapWithConcurrency(lines,5,async(input,index)=>{
        const lineNumber=index+1;
        if(isAddressInput(input)){
          const batchResult=addressMatches.get(index);
          if(batchResult?.error) return {ok:false,input,reason:batchResult.error.message||'Google 地址查询失败'};
          const match=batchResult?.match||null;
          if(!match) return {ok:false,input,reason:'未找到匹配地址'};
          const props=match.feature.properties;
          const requestedSuburb=props.locality_name||fallbackSuburb(input);
          const suburbName=await ensureSpecificSuburb(requestedSuburb);
          let zone='Outside delivery area';
          if(suburbName){
            zone=props.postcode==='3095'
              ?localityZones[suburbName]||zoneByPostcode[props.postcode]||'Outside delivery area'
              :zoneByPostcode[props.postcode]||'Outside delivery area';
            mergeSuburbSelection(suburbName,zone,lineNumber);
          }
          return {
            ok:true,
            type:'address',
            input,
            lineNumber,
            feature:match.feature,
            suburbName:suburbName||normaliseSuburbInput(requestedSuburb),
            zone,
            ambiguous:false,
            notice:suburbName?'':'地址已定位，但暂无本地 suburb 边界'
          };
        }
        const suburbName=await ensureSpecificSuburb(input);
        if(!suburbName) return {ok:false,input,reason:'未找到匹配 suburb'};
        const zone=await getSuburbZone(suburbName);
        mergeSuburbSelection(suburbName,zone,lineNumber);
        return {ok:true,type:'suburb',input,lineNumber,suburbName,zone};
      },updateSearchProgress);

      showSearchMode();
      results.filter(result=>result?.ok&&result.type==='address').forEach(addAddressMarker);
      suburbData.setStyle(suburbFeatureStyle);
      fitSearchResults();
      updateAddressMarkerSizes();
      updateSuburbTagToggle();

      const addressCount=results.filter(result=>result?.ok&&result.type==='address').length;
      const suburbCount=results.filter(result=>result?.ok&&result.type==='suburb').length;
      const failures=results.filter(result=>!result?.ok);
      const notices=results.filter(result=>result?.notice);
      setSearchResult(
        '<div class="result-summary-grid">'+
          `<div class="result-metric"><strong>${addressCount}</strong><span>地址点</span></div>`+
          `<div class="result-metric"><strong>${suburbCount}</strong><span>Suburb</span></div>`+
          `<div class="result-metric"><strong>${selectedSuburbs.size}</strong><span>高亮区域</span></div>`+
        '</div>',
        [
          ...notices.map(result=>`${result.input} — ${result.notice}`),
          ...failures.map(result=>`${result.input} — ${result.reason}`)
        ],
        failures.length===lines.length
      );
    }catch(error){
      console.error(error);
      setSearchResult(`搜索失败：${escapeHtml(error.message||'Unknown error')}`,[],true);
    }finally{
      searchButton.disabled=false;
      clearButton.disabled=false;
      updateBoundaryToggle();
      searchProgress.hidden=true;
    }
  }

  function showKeySetup(message='请输入 Google Maps API Key 以启动地图。'){
    statusElement.hidden=false;
    statusElement.className='status api-key-setup';
    statusElement.innerHTML=
      '<strong>Google Maps 设置</strong>'+
      `<p>${escapeHtml(message)}</p>`+
      '<div class="api-key-row"><input id="googleKeyInput" type="password" autocomplete="off" placeholder="AIza..."><button id="saveGoogleKey" type="button">保存并启动</button></div>'+
      '<span class="api-key-note">Key 只保存在当前浏览器。正式上传 GitHub 前，请在 config.js 中使用已限制到 GitHub Pages 域名的浏览器 Key。</span>';
    document.getElementById('saveGoogleKey').addEventListener('click',()=>{
      const key=document.getElementById('googleKeyInput').value.trim();
      if(!key) return;
      localStorage.setItem(KEY_STORAGE,key);
      location.reload();
    });
  }

  function loadGoogleMaps(){
    const key=String(window.GOOGLE_MAPS_API_KEY||localStorage.getItem(KEY_STORAGE)||'').trim();
    if(!key){
      showKeySetup();
      return;
    }
    window.initGoogleDeliveryMap=initialise;
    window.gm_authFailure=()=>{
      localStorage.removeItem(KEY_STORAGE);
      showKeySetup('API Key 无效或当前域名未获授权，请检查 Google Cloud 设置。');
    };
    const script=document.createElement('script');
    script.async=true;
    script.defer=true;
    script.src='https://maps.googleapis.com/maps/api/js?'+new URLSearchParams({
      key,
      callback:'initGoogleDeliveryMap',
      v:'weekly',
      loading:'async',
      language:'en',
      region:'AU'
    });
    script.onerror=()=>showKeySetup('Google Maps 脚本加载失败，请检查网络、API Key 和域名限制。');
    document.head.appendChild(script);
  }

  async function initialise(){
    try{
      map=new google.maps.Map(document.getElementById('map'),googleMapOptions());
      if(roadIconMode==='custom'&&!cloudMapId){
        console.warn('Option 2 is using the normal vector basemap. Add GOOGLE_MAPS_MAP_ID in config.js to apply the cloud style that hides road numbers and POI icons.');
      }
      geocoder=new google.maps.Geocoder();
      infoWindow=new google.maps.InfoWindow();
      if(roadIconMode==='custom'&&cloudMapId){
        ({AdvancedMarkerElement}=await google.maps.importLibrary('marker'));
        markerProjection=new google.maps.OverlayView();
        markerProjection.onAdd=()=>{};
        markerProjection.draw=()=>requestAnimationFrame(layoutAddressLabels);
        markerProjection.onRemove=()=>{};
        markerProjection.setMap(map);
      }
      infoWindow.addListener('closeclick',()=>{infoOpen=false});
      map.addListener('click',closeInfo);
      map.addListener('zoom_changed',()=>{
        defaultData?.setStyle(defaultFeatureStyle);
        suburbData?.setStyle(suburbFeatureStyle);
        updateAddressMarkerSizes();
        updatePostcodeLabels();
      });
      map.addListener('idle',()=>requestAnimationFrame(layoutAddressLabels));

      ensureSuburbLayer();
      await loadSuburbBoundaries();
      suburbData.setMap(null);
      suburbData.setStyle(suburbFeatureStyle);
      if(defaultBounds&&!defaultBounds.isEmpty()) map.fitBounds(defaultBounds,35);
      updateBoundaryToggle();
      updateLegend();
      if(roadIconMode==='custom'&&!cloudMapId){
        statusElement.hidden=false;
        statusElement.className='status';
        statusElement.innerHTML='<strong>方案 2 已使用高清矢量地图</strong><br>请在 config.js 填入矢量 Map ID，云端样式才会隐藏道路编号与地点图标，并只保留机场。';
      }else{
        statusElement.hidden=true;
        statusElement.className='status';
      }
      searchButton.disabled=false;
      clearButton.disabled=false;
    }catch(error){
      console.error(error);
      statusElement.hidden=false;
      statusElement.className='status error';
      statusElement.textContent=`地图加载失败：${error.message||'Unknown error'}`;
    }
  }

  panelToggle.addEventListener('click',()=>{
    const collapsed=searchPanel.classList.toggle('collapsed');
    panelToggle.textContent=collapsed?'+':'−';
    panelToggle.title=collapsed?'展开':'收起';
    panelToggle.setAttribute('aria-label',collapsed?'Expand search panel':'Collapse search panel');
  });
  searchButton.addEventListener('click',runBatchSearch);
  clearButton.addEventListener('click',()=>resetSearch(true));
  boundaryToggleButton?.addEventListener('click',()=>setAllBoundariesVisible(!boundariesVisible));
  suburbTagToggleButton?.addEventListener('click',()=>setSuburbTagsVisible(!suburbTagsVisible));
  resultMarkButton?.addEventListener('click',applyPendingAddressMarks);
  sheetImportButton?.addEventListener('click',importAddressesFromGoogleSheets);
  searchInput.addEventListener('input',updateInputCount);
  searchInput.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){
      event.preventDefault();
      runBatchSearch();
    }
  });
  updateInputCount();
  updateSuburbTagToggle();
  updateResultMarkButton();
  loadGoogleMaps();
})();
