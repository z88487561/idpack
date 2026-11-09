const CACHE='idpack-v2';
const SHELL=['./','index.html','app.js','style.css','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
// stale-while-revalidate：App 殼與 OpenCV.js（首次載入後可離線使用）
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  e.respondWith(caches.match(req).then(hit=>{
    const net=fetch(req).then(res=>{
      if(res&&(res.ok||res.type==='opaque')){const cp=res.clone();caches.open(CACHE).then(c=>c.put(req,cp));}
      return res;
    }).catch(()=>hit);
    return hit||net;
  }));
});
