// Real browser checks; start Vite first. Uses the same Chromium/BASE_URL options as rink-ui-test.mjs.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', e => errors.push(e.message));
try {
  await page.goto(process.env.BASE_URL ?? 'http://localhost:5173');
  await page.getByRole('button', { name: /^СКА/ }).click();
  await page.getByRole('button', { name: 'Начать карьеру', exact: true }).click();
  await page.getByRole('button', { name: 'Управление командой →', exact: true }).click();
  const hub = page.locator('[data-coaching-hub]');
  await hub.waitFor();
  assert.equal(await hub.getByText('Имена — справочный срез', { exact: false }).count(), 0);
  assert.equal(await hub.locator('[data-coach^="free-coach-"]').count(), 12);
  const read = () => page.evaluate(async () => { const {store} = await import(performance.getEntriesByType('resource').find(e => /\/src\/game\/state\.ts(?:\?|$)/.test(e.name)).name); const s=store.get(); return { coaches: s.teams[s.userTeamId].coaches, market:s.coachMarket, management:s.teams[s.userTeamId].management }; });
  const original = await read();
  const outgoing = original.coaches.find(c=>c.role==='head'), assistant = original.coaches.find(c=>c.role==='assistant');
  await hub.locator(`[data-coach="${outgoing.id}"]`).locator('..').getByRole('button', {name:'Уволить', exact:true}).click();
  await page.locator('.fixed.inset-0.z-50').getByRole('button', {name:'Уволить',exact:true}).click();
  assert.ok((await read()).coaches.some(c=>c.id===assistant.id && c.acting));
  assert.ok(await hub.getByText('Ассистент · вакансия', {exact:true}).isVisible());
  await hub.getByRole('button',{name:'Ассистент',exact:true}).click();
  const offer = hub.locator('[data-coach="free-coach-vorobyov"]').locator('..');
  await offer.getByRole('button',{name:/Нанять: Ассистент/}).click();
  await page.locator('.fixed.inset-0.z-50').getByRole('button',{name:'Назначить',exact:true}).click();
  assert.equal((await read()).coaches.find(c=>c.id==='free-coach-vorobyov').role,'assistant');
  await hub.getByRole('button',{name:'Главный тренер',exact:true}).click();
  await hub.locator('[data-coach="free-coach-krikunov"]').locator('..').getByRole('button',{name:/Нанять:/}).click();
  await page.locator('.fixed.inset-0.z-50').getByRole('button',{name:'Назначить',exact:true}).click();
  let state = await read();
  assert.ok(state.coaches.some(c=>c.id==='free-coach-krikunov' && c.role==='head' && !c.acting));
  assert.ok(state.coaches.some(c=>c.id==='free-coach-vorobyov' && c.role==='assistant'));
  assert.ok(state.market.some(c=>c.id===assistant.id));
  await page.evaluate(async()=>{ const {saveNow} = await import(performance.getEntriesByType('resource').find(e => /\/src\/game\/state\.ts(?:\?|$)/.test(e.name)).name); await saveNow(); });
  await page.reload();
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();
  await page.getByRole('button',{name:'Управление командой →',exact:true}).click();
  state = await read(); assert.equal(state.coaches.find(c=>c.role==='head').id,'free-coach-krikunov');
  console.log('ok real market, dismissal/interim, both appointment roles and reload');
  for (const width of [1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({width,height:900});
    if (!(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1))) { console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>({tag:n.tagName,cls:n.className,text:n.textContent.slice(0,90),right:n.getBoundingClientRect().right})).slice(0,18))); await page.screenshot({path:'.arena/overflow.png',fullPage:true}); throw Error(`overflow ${width}`); }
    const cards=await hub.locator('[data-coach]').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right})));
    assert.ok(cards.every(c=>c.x>=0 && c.right<=width+1));
  }
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'.arena/management-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Инфраструктура',exact:true}).click();
  assert.equal(await hub.count(),0);
  console.log('ok desktop/mobile geometry, compact staff cards and separate infrastructure');
  // Exercise the actual negotiation modal and actions against a controlled eligible free agent.
  await page.evaluate(async()=>{
    const G=await import(performance.getEntriesByType('resource').find(e => /\/src\/game\/state\.ts(?:\?|$)/.test(e.name)).name); const s=G.store.get();
    const id=s.freeAgents.find(id=>s.players[id].age<=23 || s.players[id].overall<=76); window.testPlayer=id;
    G.store.update(s=>{const p=s.players[id]; p.rightsTeamId=null; s.teams[s.userTeamId].budget=1e10; s.league.salaryCap=1e10;});
    const RM=await import('/node_modules/.vite/deps/react.js'), React=RM.default??RM;
    const DOM=await import('/node_modules/.vite/deps/react-dom_client.js');
    const {NegotiationModal}=await import('/src/components/Contracts.tsx');
    const node=document.createElement('div'); document.body.appendChild(node);
    (DOM.createRoot??DOM.default.createRoot)(node).render(React.createElement(NegotiationModal,{id,onClose:()=>{}}));
  });
  const type=page.locator('[data-contract-type]'); await type.waitFor();
  await type.getByRole('radio',{name:'Двусторонний',exact:true}).check();
  assert.ok(await type.getByRole('radio',{name:'Двусторонний',exact:true}).isChecked());
  await type.getByRole('radio',{name:'Односторонний',exact:true}).check();
  await type.getByRole('radio',{name:'Двусторонний',exact:true}).check();
  await page.getByRole('button',{name:'Принять запрос игрока',exact:true}).click();
  const signed=await page.evaluate(async()=>{const {store}=await import(performance.getEntriesByType('resource').find(e => /\/src\/game\/state\.ts(?:\?|$)/.test(e.name)).name); return store.get().players[window.testPlayer];});
  assert.equal(signed.contract.twoWay,true); assert.ok(signed.teamId);
  console.log('ok explicit one-way/two-way negotiation selection and saved contract');
  assert.deepEqual(errors,[]); console.log('PASS: management real browser flow');
} finally { await browser.close(); }
