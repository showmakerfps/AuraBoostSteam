const {contextBridge,ipcRenderer}=require('electron');
const names=['get','addAccount','switchAccount','removeAccount','consent','qr','password','guard','cancelAuth','resume','disconnect','forget','settings','scan','presence','start','stop','agreement','minimize','maximize','close','exit'];
contextBridge.exposeInMainWorld('aura',Object.fromEntries([...names.map(n=>[n,(arg)=>ipcRenderer.invoke('aura:'+n,arg)]),['subscribe',fn=>{ipcRenderer.on('state',(_e,s)=>fn(s));}]]));
