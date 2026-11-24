'use strict';
(function(root){
 const hashOK=h=>typeof h==='string'&&/^[a-f0-9]{40}$/i.test(h)&&!/^0+$/.test(h);
 function covers(g){const id=Number(g.id);if(!Number.isSafeInteger(id)||id<1)return [];const urls=[`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,`https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,`https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${id}/capsule_616x353.jpg`];if(hashOK(g.iconHash))urls.push(`https://media.steampowered.com/steamcommunity/public/images/apps/${id}/${g.iconHash}.jpg`);return urls;}
 function avatars(h){return hashOK(h)?[`https://avatars.steamstatic.com/${h}_medium.jpg`,`https://avatars.akamai.steamstatic.com/${h}_medium.jpg`,`https://avatars.fastly.steamstatic.com/${h}_full.jpg`]:[];}
 if(typeof module!=='undefined')module.exports={covers,avatars};else root.auraImages={covers,avatars};
})(typeof window==='undefined'?null:window);
