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

  const statusElement=document.getElementById('status');
  const searchPanel=document.getElementById('searchPanel');
  const panelToggle=document.getElementById('panelToggle');
  const searchInput=document.getElementById('searchInput');
  const inputCount=document.getElementById('inputCount');
  const searchButton=document.getElementById('searchButton');
  const clearButton=document.getElementById('clearButton');
  const boundaryToggleButton=document.getElementById('boundaryToggleButton');
  const boundaryToggleLabel=document.getElementById('boundaryToggleLabel');
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
  let defaultData=null;
  let suburbData=null;
  let defaultBounds=null;
  let suburbLoadPromise=null;
  let searchActive=false;
  let boundariesVisible=false;
  let infoOpen=false;

  searchButton.disabled=true;
  clearButton.disabled=true;
  if(boundaryToggleButton) boundaryToggleButton.disabled=true;
  if(staticMode) document.body.classList.add('static-map');

  function updateInputCount(){
    const count=searchInput.value.split(/\r?\n/).filter(line=>line.trim()).length;
    inputCount.textContent=`${count} 条`;
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
    const showAll=!searchActive;
    return {
      clickable:showAll||Boolean(selection),
      visible:showAll||Boolean(selection),
      strokeColor:selection?'#A66B00':'#475467',
      strokeOpacity:showAll||selection ? .9 : 0,
      strokeWeight:suburbBoundaryWeight(),
      fillColor:selection?'#F2B134':'#FFFFFF',
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
        suburbData.overrideStyle(event.feature,{
          fillOpacity:searchActive ? .45 : .12,
          strokeColor:searchActive?'#7A4E00':'#344054'
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

  function addAddressMarker(result){
    const [longitude,latitude]=result.feature.geometry.coordinates;
    const props=result.feature.properties;
    const marker=new google.maps.Marker({
      position:{lat:latitude,lng:longitude},
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
    addressMarkers.splice(0).forEach(marker=>marker.setMap(null));
  }

  function updateAddressMarkerSizes(){
    addressMarkers.forEach(marker=>marker.setIcon(markerIcon()));
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
      legendElement.innerHTML=
        '<span class="sw" style="background:#F2B134"></span>Selected suburb&nbsp;&nbsp;'+
        '<span class="sw" style="background:#EA4335;border-radius:50% 50% 50% 0;transform:rotate(-45deg)"></span>Address';
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
    addressMarkers.forEach(marker=>bounds.extend(marker.getPosition()));
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
      map=new google.maps.Map(document.getElementById('map'),{
        center:{lat:-37.8136,lng:144.9631},
        zoom:10,
        renderingType:google.maps.RenderingType.VECTOR,
        isFractionalZoomEnabled:true,
        mapTypeControl:false,
        streetViewControl:false,
        fullscreenControl:true,
        gestureHandling:'greedy'
      });
      geocoder=new google.maps.Geocoder();
      infoWindow=new google.maps.InfoWindow();
      infoWindow.addListener('closeclick',()=>{infoOpen=false});
      map.addListener('click',closeInfo);
      map.addListener('zoom_changed',()=>{
        defaultData?.setStyle(defaultFeatureStyle);
        suburbData?.setStyle(suburbFeatureStyle);
        updateAddressMarkerSizes();
        updatePostcodeLabels();
      });

      ensureSuburbLayer();
      await loadSuburbBoundaries();
      suburbData.setMap(null);
      suburbData.setStyle(suburbFeatureStyle);
      if(defaultBounds&&!defaultBounds.isEmpty()) map.fitBounds(defaultBounds,35);
      updateBoundaryToggle();
      updateLegend();
      statusElement.hidden=true;
      statusElement.className='status';
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
  searchInput.addEventListener('input',updateInputCount);
  searchInput.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){
      event.preventDefault();
      runBatchSearch();
    }
  });
  updateInputCount();
  loadGoogleMaps();
})();
