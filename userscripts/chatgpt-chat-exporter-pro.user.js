// ==UserScript==
// @name         ChatGPT Chat Exporter – Pro (token fix, robust MD fences, ZIP safe concat, Copy, Print via iframe, Settings; no auto-update)
// @namespace    local
// @version      1.0.0.1-gp
// @description  Esporta/Condividi conversazioni ChatGPT: MD/HTML/TXT, Copy, Print (iframe), ZIP (md+html+txt). Fences Markdown robusti, token a prova di escape, righe vuote attorno ai blocchi. Titolo lungo, menu flottante, impostazioni locali. Nessun auto-update, nessuna rete.
// @author       GP
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=openai.com
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  const BTN_ID   = 'gp-export-anchor';
  const MENU_ID  = 'gp-export-menu';
  const MODAL_ID = 'gp-export-settings-modal';
  const STYLE_ID = 'gp-export-style';

  const DEFAULT_SETTINGS = {
    includeTimestamps: true,
    includeSource:     true,
    filenamePrefix:    '',     // es. 'GPT_'
    titleMaxLen:       120,
    stripCodeInTXT:    false
  };

  // ---------- Utils ----------
  const pad = (n) => String(n).padStart(2, '0');
  function formatDate(d = new Date()) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  }
  function saveSettings(s){ localStorage.setItem('gpExportSettings', JSON.stringify(s)); }
  function loadSettings(){
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem('gpExportSettings')||'{}')) }; }
    catch { return { ...DEFAULT_SETTINGS }; }
  }
  function sanitizeFilenamePart(s, maxLen){
    const cleaned = String(s).replace(/[\\/:*?"<>|]+/g,'_').replace(/_+$/g,'').replace(/\s+/g,' ').trim();
    const safe = cleaned || 'Conversation';
    return safe.slice(0, maxLen);
  }
  function isGenericTitle(t){
    if(!t) return true;
    const s=t.trim().toLowerCase();
    const generic=['chatgpt','cronologia','cronologia chat','new chat','untitled','conversazione','conversation','home','chats'];
    return generic.some(g=>s===g||s.startsWith(g));
  }
  const escapeHtml = s => String(s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const escapeAttr = s => String(s).replace(/"/g,'&quot;');

  // Markdown escaping per testo NORMALE (non i blocchi codice!)
  function escapeMarkdown(text){
    return text
      .replace(/\\/g,'\\\\')
      .replace(/\*/g,'\\*')
      .replace(/_/g,'\\_')
      // NON escapiamo i backtick
      .replace(/\n{3,}/g,'\n\n');
  }

  // ---------- Titolo conversazione ----------
  function getConversationTitle(){
    const candidates=['[data-testid="conversation-title"]','main h1','main h2','[role="main"] h1','[role="main"] h2','header h1','header h2'];
    for(const sel of candidates){
      const t=document.querySelector(sel)?.textContent?.trim();
      if(t && !isGenericTitle(t)) return t;
    }
    if(document.title){
      const t=document.title.replace(/\s*-\s*ChatGPT\s*$/i,'').trim();
      if(t && !isGenericTitle(t)) return t;
    }
    const sidebarCandidates=['[data-testid="conversation-list"] [aria-current="page"]','[data-testid="conversation-list"] [data-active="true"]','aside nav [aria-current="page"]'];
    for(const sel of sidebarCandidates){
      const t=document.querySelector(sel)?.textContent?.trim();
      if(t && !isGenericTitle(t)) return t;
    }
    const firstUser=document.querySelector('[data-message-author-role="user"] .whitespace-pre-wrap, [data-message-author-role="user"]');
    if(firstUser){
      const txt=firstUser.textContent?.trim().replace(/\s+/g,' ')||'';
      const snippet=txt.slice(0,100);
      if(snippet) return `Chat – ${snippet}${txt.length>100?'…':''}`;
    }
    const now=new Date();
    return `Conversation-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  // ---------- Raccolta turni ----------
  function collectTurns(){
    let turns=Array.from(document.querySelectorAll('[data-message-author-role]'));
    if(!turns.length){
      turns=Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"], article, div[role="listitem"]'));
    }
    return turns;
  }

  // ====== Fences robusti in MD ======
  function longestRunOfBackticks(str){
    let max=0, cur=0;
    for (let i=0;i<str.length;i++){
      if (str[i]==='`'){ cur++; if (cur>max) max=cur; }
      else { cur=0; }
    }
    return max;
  }
  function makeFenceFor(codeText){
    const maxInCode = longestRunOfBackticks(codeText);
    const len = Math.max(3, maxInCode + 1);     // fence più lungo di qualunque run presente
    return '`'.repeat(len);
  }

  function processMessageContentMD(el){
    // 1) raccogli i blocchi <pre> e sostituiscili con segnaposto “safe”
    const clone=el.cloneNode(true);
    const blocks = []; // [{token, fence, lang, code}]
    let idx=0;

    clone.querySelectorAll('pre').forEach(pre=>{
      // testo e lingua
      const code = pre.innerText.replace(/\r/g,'').replace(/\s+$/,''); // preserva indentazione iniziale
      const langMatch = pre.querySelector('code')?.className?.match(/language-([a-zA-Z0-9]+)/);
      const lang = langMatch ? langMatch[1] : '';

      const fence = makeFenceFor(code);
      const token = `§§CB${idx++}§§`; // token safe

      const span = document.createElement('span');
      span.textContent = token;
      pre.replaceWith(span);

      blocks.push({ token, fence, lang, code });
    });

    // 2) testo normale → escape markdown
    let text = clone.innerText.replace(/\r/g,'').trim();
    text = escapeMarkdown(text);

    // 3) reinserisci i blocchi al posto dei token, con righe vuote sopra/sotto
    for (const {token, fence, lang, code} of blocks){
      const fenced =
        `\n\n${fence}${lang ? (lang.startsWith('.')?lang:(' '+lang)) : ''}\n` +
        `${code}\n` +
        `${fence}\n\n`;
      text = text.split(token).join(fenced);
    }

    text = text.replace(/\n{4,}/g, '\n\n\n'); // de-bloat
    return text.trim();
  }

  function processMessageContentTXT(el, stripCode){
    const clone=el.cloneNode(true);
    clone.querySelectorAll('pre').forEach(pre=>{
      if (stripCode) {
        pre.replaceWith('');
      } else {
        const code = pre.innerText.replace(/\r/g,'').trimEnd();
        const txtBlock = `\n----- CODE -----\n${code}\n----- END CODE -----\n`;
        pre.replaceWith(txtBlock);
      }
    });
    clone.querySelectorAll('img, canvas, svg, video, picture').forEach(m=>m.replaceWith('[Media]'));
    return clone.innerText.replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim();
  }

  // ---------- Builder MD / HTML / TXT ----------
  function collectMessagesMD(settings){
    const turns=collectTurns();
    const lines=[];
    const title=getConversationTitle();
    const date =formatDate();
    const url  =window.location.href;

    lines.push(`# ${title}\n`);
    lines.push(`**Date:** ${date}`);
    if(settings.includeSource) lines.push(`**Source:** [${location.hostname}](${url})`);
    lines.push(`\n---\n`);

    turns.forEach(turn=>{
      const role=turn.getAttribute?.('data-message-author-role');
      const sender=role==='user'?'You':'ChatGPT';
      const block=turn.querySelector?.('.markdown, .prose, .whitespace-pre-wrap, [data-testid="assistant-turn"]')||turn;
      const content=block?processMessageContentMD(block):'';
      const ts=settings.includeTimestamps?` (${new Date().toLocaleTimeString()})`:'';
      if(content){
        lines.push(`### **${sender}**${ts}\n`);
        lines.push(content);
        lines.push('\n---\n');
      }
    });
    return lines.join('\n').trim();
  }

  function collectMessagesHTML(settings){
    const turns=collectTurns();
    const parts=[];
    const title=getConversationTitle();
    const date =formatDate();
    const url  =window.location.href;

    parts.push(`<h1>${escapeHtml(title)}</h1>`);
    let header=`<p><b>Date:</b> ${escapeHtml(date)}`;
    if(settings.includeSource) header+=`<br><b>Source:</b> <a href="${escapeAttr(url)}">${escapeHtml(location.hostname)}</a>`;
    header+=`</p><hr>`;
    parts.push(header);

    turns.forEach(turn=>{
      const role=turn.getAttribute?.('data-message-author-role');
      const sender=role==='user'?'You':'ChatGPT';
      const block=turn.querySelector?.('.markdown, .prose, .whitespace-pre-wrap, [data-testid="assistant-turn"]')||turn;
      const html=block?block.innerHTML:'';
      const ts=settings.includeTimestamps?` (${escapeHtml(new Date().toLocaleTimeString())})`:'';
      if(html && html.trim()){
        parts.push(`<h3>${escapeHtml(sender)}${ts}</h3>`);
        parts.push(`<div>${html}</div><hr>`);
      }
    });

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${parts.join('\n')}</body></html>`;
  }

  function collectMessagesTXT(settings){
    const turns=collectTurns();
    const lines=[];
    const title=getConversationTitle();
    const date =formatDate();
    const url  =window.location.href;

    lines.push(`${title}`);
    lines.push(`Date: ${date}`);
    if(settings.includeSource) lines.push(`Source: ${location.hostname} (${url})`);
    lines.push(``);
    lines.push(`----------------------------------------`);

    turns.forEach(turn=>{
      const role=turn.getAttribute?.('data-message-author-role');
      const sender=role==='user'?'You':'ChatGPT';
      const block=turn.querySelector?.('.markdown, .prose, .whitespace-pre-wrap, [data-testid="assistant-turn"]')||turn;
      const text =block?processMessageContentTXT(block, settings.stripCodeInTXT):'';
      const ts=settings.includeTimestamps?` (${new Date().toLocaleTimeString()})`:'';
      if(text){
        lines.push(`\n${sender}${ts}\n`);
        lines.push(text);
        lines.push(`\n----------------------------------------`);
      }
    });
    return lines.join('\n');
  }

  // ---------- Save / Copy / Print ----------
  function makeBaseName(settings){
    const date = formatDate();
    const title = getConversationTitle();
    const safe = sanitizeFilenamePart(title, settings.titleMaxLen);
    const pref = settings.filenamePrefix ? `${settings.filenamePrefix}` : '';
    return `${pref}${date}_${safe}`;
  }
  function makeFilename(ext, settings){ return `${makeBaseName(settings)}.${ext}`; }

  function saveFile(content, ext, mime, settings){
    const blob=new Blob([content],{type:mime});
    const a=document.createElement('a');
    a.download=makeFilename(ext, settings);
    a.rel='noopener';
    a.href=URL.createObjectURL(blob);
    document.body.appendChild(a);
    setTimeout(()=>{ a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 0);
  }

  async function copyToClipboard(text){
    try{ await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
    catch(e){ console.error('[Exporter] Copy failed', e); alert('Copy failed: '+(e?.message||e)); }
  }

  function printHTMLviaIframe(htmlString){
    const iframe=document.createElement('iframe');
    iframe.style.position='fixed';
    iframe.style.right='0'; iframe.style.bottom='0';
    iframe.style.width='0'; iframe.style.height='0';
    iframe.style.border='0';
    document.body.appendChild(iframe);

    const iframeDoc=iframe.contentDocument || iframe.contentWindow.document;
    iframeDoc.open(); iframeDoc.write(htmlString); iframeDoc.close();

    const done=()=> {
      try{ iframe.contentWindow.focus(); iframe.contentWindow.print(); }
      finally{ setTimeout(()=>iframe.remove(), 2000); }
    };
    if (iframeDoc.readyState === 'complete') done();
    else { iframe.onload = done; iframeDoc.addEventListener('DOMContentLoaded', done); }
  }

  // ---------- ZIP (store) | safe concat ----------
  function strToU8(str){
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    const utf8 = unescape(encodeURIComponent(str));
    const arr = new Uint8Array(utf8.length);
    for (let i=0; i<utf8.length; i++) arr[i] = utf8.charCodeAt(i);
    return arr;
  }

  const CRC_TABLE = (() => {
    let c, table = new Uint32Array(256);
    for (let n=0; n<256; n++){
      c = n;
      for (let k=0; k<8; k++){
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n]=c>>>0;
    }
    return table;
  })();

  function crc32(u8) {
    let c = 0 ^ (-1);
    for (let i=0;i<u8.length;i++){
      c = (c >>> 8) ^ CRC_TABLE[(c ^ u8[i]) & 0xFF];
    }
    return (c ^ (-1)) >>> 0;
  }

  function makeLocalHeader(nameBytes, crc, size, time, date) {
    const buf = new Uint8Array(30 + nameBytes.length);
    const dv  = new DataView(buf.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    buf.set(nameBytes, 30);
    return buf;
  }

  function makeCentralHeader(nameBytes, crc, size, time, date, localHeaderOffset) {
    const buf = new Uint8Array(46 + nameBytes.length);
    const dv  = new DataView(buf.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, localHeaderOffset, true);
    buf.set(nameBytes, 46);
    return buf;
  }

  function makeEndOfCentralDirectory(centralSize, centralOffset, totalEntries) {
    const buf = new Uint8Array(22);
    const dv  = new DataView(buf.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(4, 0, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, totalEntries, true);
    dv.setUint16(10, totalEntries, true);
    dv.setUint32(12, centralSize, true);
    dv.setUint32(16, centralOffset, true);
    dv.setUint16(20, 0, true);
    return buf;
  }

  function concatChunks(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  function dosTimeDate(d=new Date()){
    const time = ((d.getHours()   & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds()/2)) & 31);
    const date = (((d.getFullYear()-1980) & 127) << 9) | (((d.getMonth()+1) & 15) << 5) | (d.getDate() & 31);
    return {time, date};
  }

  function buildZip(entries) {
    const now = new Date();
    const {time, date} = dosTimeDate(now);

    const chunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const {name, data} of entries) {
      const safeName = name || `file-${offset}`;
      const nameBytes = strToU8(safeName);
      const crc = crc32(data);
      const size = data.length;

      const local = makeLocalHeader(nameBytes, crc, size, time, date);
      chunks.push(local);
      chunks.push(data);

      const central = makeCentralHeader(nameBytes, crc, size, time, date, offset);
      centralChunks.push(central);

      offset += local.length + size;
    }

    const centralOffset = offset;
    const centralBuf = concatChunks(centralChunks);
    chunks.push(centralBuf);
    const centralSize = centralBuf.length;

    const eocd = makeEndOfCentralDirectory(centralSize, centralOffset, entries.length);
    chunks.push(eocd);

    return concatChunks(chunks);
  }

  function saveZip(files, baseName) {
    try {
      const zipU8 = buildZip(files);
      const blob = new Blob([zipU8], {type: 'application/zip'});
      const a = document.createElement('a');
      a.download = `${baseName || 'ChatGPT_Export'}.zip`;
      a.rel = 'noopener';
      a.href = URL.createObjectURL(blob);
      document.body.appendChild(a);
      setTimeout(()=>{ a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 0);
      toast('ZIP creato');
    } catch (e) {
      console.error('[Exporter] ZIP error', e);
      alert('Export ZIP fallito: ' + (e?.message || e));
    }
  }

  function exportZIP(settings){
    try {
      toast('Creo ZIP…');
      const md   = collectMessagesMD(settings);
      const html = collectMessagesHTML(settings);
      const txt  = collectMessagesTXT(settings);

      const base = makeBaseName(settings);
      const files = [
        { name: `${base}.md`,   data: strToU8(md) },
        { name: `${base}.html`, data: strToU8(html) },
        { name: `${base}.txt`,  data: strToU8(txt) },
      ];
      saveZip(files, base);
    } catch (e) {
      console.error('[Exporter] exportZIP error', e);
      alert('Export ZIP fallito: ' + (e?.message || e));
    }
  }

  // ---------- UI ----------
  function ensureStyles(){
    if(document.getElementById(STYLE_ID)) return;
    const st=document.createElement('style');
    st.id=STYLE_ID;
    st.textContent=`
      #${MENU_ID}{
        position: fixed;
        z-index: 2147483647;
        background: #1f2937;
        color: #fff;
        border: 1px solid #374151;
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        padding: 6px;
        display: none;
        min-width: 240px;
      }
      #${MENU_ID} button{
        display: block;
        width: 100%;
        text-align: left;
        background: transparent;
        color: #fff;
        border: none;
        padding: 6px 8px;
        font-size: 12px;
        border-radius: 6px;
        cursor: pointer;
      }
      #${MENU_ID} button:hover{ background: #10a37f; color: #fff; }
      #${BTN_ID}{
        display:inline-block;
        margin:6px;
        padding:4px 8px;
        border-radius:6px;
        background:#10a37f;
        color:#fff;
        border:none;
        cursor:pointer;
        font-size:12px;
        line-height:1.2;
      }
      .gp-toast{
        position: fixed;
        right: 12px;
        bottom: 12px;
        background: #10a37f;
        color:#fff;
        padding:8px 10px;
        border-radius:8px;
        z-index:2147483647;
        font-size:12px;
        opacity:0.95;
      }
      #${MODAL_ID}{
        position: fixed;
        z-index: 2147483647;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.45);
      }
      #${MODAL_ID} .panel{
        background: #111827;
        color:#e5e7eb;
        min-width: 320px;
        max-width: 520px;
        padding:16px;
        border-radius:10px;
        border:1px solid #374151;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      }
      #${MODAL_ID} label{ display:flex; align-items:center; gap:8px; margin:8px 0; font-size:13px; }
      #${MODAL_ID} input[type="text"], #${MODAL_ID} input[type="number"]{
        width: 100%;
        background:#0b1220;
        color:#e5e7eb;
        border:1px solid #374151;
        border-radius:6px;
        padding:6px 8px;
      }
      #${MODAL_ID} .actions{ display:flex; gap:8px; justify-content:flex-end; margin-top:12px; }
      #${MODAL_ID} .btn{ background:#10a37f; color:#fff; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:12px; }
      #${MODAL_ID} .btn.secondary{ background:#374151; }
    `;
    document.head.appendChild(st);
  }

  function toast(msg){
    const el=document.createElement('div');
    el.className='gp-toast';
    el.textContent=msg;
    document.body.appendChild(el);
    setTimeout(()=>el.remove(),1800);
  }

  function createSettingsModal(){
    let modal=document.getElementById(MODAL_ID);
    if(modal) return modal;
    const s=loadSettings();
    modal=document.createElement('div');
    modal.id=MODAL_ID;
    modal.innerHTML=`
      <div class="panel">
        <h3 style="margin-top:0;margin-bottom:10px;">Chat Exporter – Settings</h3>
        <label><input type="checkbox" id="gp-set-ts" ${s.includeTimestamps?'checked':''}> Include timestamps</label>
        <label><input type="checkbox" id="gp-set-src" ${s.includeSource?'checked':''}> Include source URL in header</label>
        <label><input type="checkbox" id="gp-set-strip" ${s.stripCodeInTXT?'checked':''}> TXT: remove code blocks</label>
        <label>Filename prefix (optional)
          <input type="text" id="gp-set-pref" placeholder="es. GPT_" value="${escapeAttr(s.filenamePrefix)}">
        </label>
        <label>Max title length in filename
          <input type="number" id="gp-set-max" min="20" max="200" value="${s.titleMaxLen}">
        </label>
        <div class="actions">
          <button class="btn secondary" id="gp-set-cancel">Cancel</button>
          <button class="btn" id="gp-set-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', e=>{ if(e.target===modal) hideSettings(); });
    modal.querySelector('#gp-set-cancel').addEventListener('click', hideSettings);
    modal.querySelector('#gp-set-save').addEventListener('click', ()=>{
      const ns={
        includeTimestamps: modal.querySelector('#gp-set-ts').checked,
        includeSource:     modal.querySelector('#gp-set-src').checked,
        stripCodeInTXT:    modal.querySelector('#gp-set-strip').checked,
        filenamePrefix:    modal.querySelector('#gp-set-pref').value||'',
        titleMaxLen:       Math.max(20, Math.min(200, parseInt(modal.querySelector('#gp-set-max').value||'120',10)))
      };
      saveSettings(ns);
      hideSettings();
      toast('Settings saved');
    });
    return modal;
  }
  function showSettings(){ createSettingsModal().style.display='flex'; }
  function hideSettings(){ const m=document.getElementById(MODAL_ID); if(m) m.style.display='none'; }

  function createMenu(){
    let menu=document.getElementById(MENU_ID);
    if(menu) return menu;
    menu=document.createElement('div');
    menu.id=MENU_ID;

    const addBtn=(label, handler)=>{
      const b=document.createElement('button');
      b.textContent=label;
      b.addEventListener('click', ()=>{ hideMenu(); handler(); });
      menu.appendChild(b);
    };

    // Export singoli
    addBtn('Export Markdown (.md)', ()=>{
      const s=loadSettings();
      saveFile(collectMessagesMD(s),'md','text/markdown',s);
    });
    addBtn('Export HTML (.html)', ()=>{
      const s=loadSettings();
      saveFile(collectMessagesHTML(s),'html','text/html',s);
    });
    addBtn('Export Text (.txt)', ()=>{
      const s=loadSettings();
      saveFile(collectMessagesTXT(s),'txt','text/plain',s);
    });

    // ZIP combinato
    addBtn('Export ZIP (md + html + txt)', ()=>{
      const s=loadSettings();
      exportZIP(s);
    });

    // Copy
    addBtn('Copy Markdown', async ()=>{
      const s=loadSettings();
      await copyToClipboard(collectMessagesMD(s));
    });
    addBtn('Copy HTML', async ()=>{
      const s=loadSettings();
      await copyToClipboard(collectMessagesHTML(s));
    });
    addBtn('Copy Text', async ()=>{
      const s=loadSettings();
      await copyToClipboard(collectMessagesTXT(s));
    });

    // Print via iframe (no popup)
    addBtn('Print (→ PDF)', ()=>{
      const s=loadSettings();
      const html=collectMessagesHTML(s);
      printHTMLviaIframe(html);
    });

    // Settings
    addBtn('Settings…', ()=>showSettings());

    document.body.appendChild(menu);
    return menu;
  }

  function showMenuNear(el){
    const menu=createMenu();
    const rect=el.getBoundingClientRect();
    let left=rect.right+8, top=rect.top+8;
    const vw=window.innerWidth, vh=window.innerHeight;
    menu.style.display='block';
    const mw=menu.offsetWidth||240, mh=menu.offsetHeight||320;
    if(left+mw>vw-8) left=Math.max(8, vw-mw-8);
    if(top+mh>vh-8) top=Math.max(8, vh-mh-8);
    menu.style.left=`${left}px`;
    menu.style.top =`${top}px`;
    setTimeout(()=>{
      document.addEventListener('mousedown', onDocClick, {capture:true, once:true});
      document.addEventListener('keydown', onEsc, { once:true });
    },0);
  }
  function hideMenu(){ const menu=document.getElementById(MENU_ID); if(menu) menu.style.display='none'; }
  function onDocClick(e){ const menu=document.getElementById(MENU_ID); if(menu && !menu.contains(e.target)) hideMenu(); }
  function onEsc(e){ if(e.key==='Escape') hideMenu(); }

  function makeAnchorButton(){
    const btn=document.createElement('button');
    btn.id=BTN_ID;
    btn.type='button';
    btn.textContent='Export';
    btn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      const menu=document.getElementById(MENU_ID);
      if(menu && menu.style.display==='block') hideMenu();
      else showMenuNear(btn);
    });
    return btn;
  }
  function findSidebarContainer(){
    return document.querySelector('aside,nav[aria-label],[data-testid="left-panel"],[data-testid="sidebar"],nav');
  }
  function addExportAnchor(){
    if(document.getElementById(BTN_ID)) return;
    ensureStyles();
    const target=findSidebarContainer();
    if(target){ target.appendChild(makeAnchorButton()); }
    else {
      const fl=makeAnchorButton();
      fl.style.position='fixed';
      fl.style.right='12px';
      fl.style.bottom='12px';
      fl.style.zIndex='2147483647';
      document.body.appendChild(fl);
    }
  }

  let observing=false;
  function startObserver(){
    if(observing) return;
    const obs=new MutationObserver(()=>addExportAnchor());
    obs.observe(document.documentElement,{childList:true, subtree:true});
    observing=true;
  }

  function init(){
    addExportAnchor();
    startObserver();
    setInterval(addExportAnchor, 3000);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
