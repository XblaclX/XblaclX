#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUTPUT = process.env.OUTPUT_PATH || 'dist/contributions.svg';
const COLS = 38, ROWS = 7, CELL = 10, STEP = 13;
const GRID_X = 18, GRID_Y = 20, WIDTH = 535, HEIGHT = 175;
const LOOP = 16;

if (!USERNAME || !TOKEN) throw new Error('Missing GH_USERNAME or GH_TOKEN/GITHUB_TOKEN');

const QUERY = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{date contributionCount color}}}}}}`;

async function fetchWeeks(){
  const r = await fetch('https://api.github.com/graphql', {method:'POST',headers:{Authorization:`bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query:QUERY,variables:{login:USERNAME}})});
  if(!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
  const j=await r.json(); if(j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data.user.contributionsCollection.contributionCalendar.weeks;
}

function cells(weeks){
  const recent=weeks.slice(-COLS), out=[];
  recent.forEach((w,c)=>w.contributionDays.forEach((d,r)=>out.push({c,r,x:GRID_X+c*STEP,y:GRID_Y+r*STEP,count:d.contributionCount||0,color:d.color||'#0b2a16'})));
  return out;
}

function svg(weeks){
  const cs=cells(weeks), max=Math.max(1,...cs.map(x=>x.count));
  const rects=cs.map(x=>`<rect x="${x.x}" y="${x.y}" width="${CELL}" height="${CELL}" rx="2" fill="${x.count?x.color:'#08220f'}" opacity="${x.count?0.95:0.5}"/>`).join('\n');
  const hot=[...cs].filter(x=>x.count).sort((a,b)=>b.count-a.count).slice(0,14);
  const pulses=hot.map((x,i)=>{
    const t=(x.c/(COLS-1))*0.85+0.06;
    return `<circle cx="${x.x+CELL/2}" cy="${x.y+CELL/2}" r="0" fill="none" stroke="#39ff88" stroke-width="1.5" opacity="0"><animate attributeName="r" dur="${LOOP}s" repeatCount="indefinite" keyTimes="0;${t.toFixed(3)};${Math.min(0.99,t+0.035).toFixed(3)};1" values="0;1;10;10"/><animate attributeName="opacity" dur="${LOOP}s" repeatCount="indefinite" keyTimes="0;${t.toFixed(3)};${Math.min(0.99,t+0.035).toFixed(3)};1" values="0;1;0;0"/></circle>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#03150b"/><stop offset="1" stop-color="#020805"/></linearGradient><filter id="g"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="16" fill="url(#bg)"/>
  <text x="18" y="14" fill="#39ff88" font-family="Courier New,monospace" font-size="10" letter-spacing="1.5">CONTRIBUTION.MATRIX // LIVE</text>
  <g>${rects}</g><g>${pulses}</g>
  <g filter="url(#g)"><line x1="18" y1="148" x2="500" y2="148" stroke="#00ff66" stroke-width="1.5" opacity=".18"/><circle cx="18" cy="148" r="3.3" fill="#00ff66"><animate attributeName="cx" values="18;500;18" dur="${LOOP}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".3;1;.3" dur="1.1s" repeatCount="indefinite"/></circle></g>
  <text x="18" y="166" fill="#5faf7a" font-family="Courier New,monospace" font-size="9">signal: activity synchronized // node: ${USERNAME}</text>
</svg>`;
}

const weeks=await fetchWeeks();
const out=path.resolve(OUTPUT); fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,svg(weeks));
console.log(`Wrote ${out}`);
