// render.js — рендерим паспорта в PNG и пакуем в один PDF.
//
// Окружение:
//   WEB_APP_URL  — публичный Apps Script Web App URL (до /exec, без параметров)
//   FROM_ID      — стартовый ID
//   TO_ID        — конечный ID (включительно)
//   CONCURRENCY  — параллельность (по умолчанию 4)
//
// Каждая страница открывается как WEB_APP_URL?id=N&print=1.
// Ждём, пока appear `body.ready` (флаг ставит сам HTML после рендера Chart.js).
// Если флаг не появился за 30 сек — берём что есть.
//
// На выходе:
//   out/png/<id>.png
//   out/passports.pdf
//   out/errors.json
//
// 881 паспорт × ~5-10 сек = 1.5-2.5 часа последовательно;
// при concurrency=4 — ~25-40 минут.

import puppeteer from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import pLimit from 'p-limit';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ── Конфиг ──
const WEB_APP_URL = (process.env.WEB_APP_URL || '').trim();
const FROM_ID = parseInt(process.env.FROM_ID || '1', 10);
const TO_ID = parseInt(process.env.TO_ID || '881', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '4', 10));

// Размер A4 landscape в пикселях @ ~150 DPI (1754×1240 — близко к печатному).
// Apps Script HTML рассчитан на A4 landscape, поэтому viewport такой же.
const VIEWPORT = { width: 1754, height: 1240, deviceScaleFactor: 2 };

const OUT = path.resolve('out');
const PNG_DIR = path.join(OUT, 'png');
const PDF_PATH = path.join(OUT, 'passports.pdf');
const ERR_PATH = path.join(OUT, 'errors.json');

// ── Проверки ──
if (!WEB_APP_URL) {
  console.error('❌ WEB_APP_URL не задан');
  process.exit(1);
}
if (!WEB_APP_URL.includes('/exec')) {
  console.warn('⚠️  WEB_APP_URL обычно заканчивается на /exec. Сейчас:', WEB_APP_URL);
}
if (FROM_ID > TO_ID) {
  console.error('❌ FROM_ID > TO_ID');
  process.exit(1);
}

await fs.mkdir(PNG_DIR, { recursive: true });

console.log(`📋 Рендер id ${FROM_ID}…${TO_ID} (${TO_ID - FROM_ID + 1} шт), параллельно ${CONCURRENCY}`);

// ── Запуск Chrome ──
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=none',
  ],
});

const errors = [];
const successIds = [];
let done = 0;
const total = TO_ID - FROM_ID + 1;

// ── Рендер одной страницы ──
async function renderOne(id) {
  const url = `${WEB_APP_URL}?id=${id}&print=1`;
  const pngPath = path.join(PNG_DIR, `${String(id).padStart(4, '0')}.png`);

  // Если уже отрендерено — пропускаем (для возобновления после прерывания)
  if (existsSync(pngPath)) {
    successIds.push(id);
    done++;
    if (done % 20 === 0) console.log(`  · ${done}/${total} (skip cached)`);
    return;
  }

  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  try {
    // Apps Script отдаёт HTML через iframe-обёртку userhtmlpreview.googleusercontent.com.
    // networkidle0 ловит конец загрузки шрифтов/Chart.js CDN.
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });

    // В v18 после того, как Chart.js нарисует радары,
    // выставляется window.__renderReady = true. Ждём этот флаг.
    // Если HTML не от v18 (старая версия) — флага не будет, упадём по таймауту
    // и снимем что есть.
    await page.waitForFunction(
      () => window.__renderReady === true,
      { timeout: 15_000 }
    ).catch(() => {
      console.warn(`  ⏱  id=${id}: флаг __renderReady не появился за 15с, снимаю как есть`);
    });

    // Дополнительная пауза на дорисовку шрифтов (Google Fonts тяжёлые)
    await new Promise((r) => setTimeout(r, 500));

    // Снимаем весь контент (fullPage учитывает реальную высоту страницы)
    await page.screenshot({
      path: pngPath,
      fullPage: true,
      type: 'png',
    });

    successIds.push(id);
  } catch (e) {
    errors.push({ id, error: String(e.message || e) });
    console.warn(`  ⚠️  id=${id}: ${e.message}`);
  } finally {
    await page.close();
    done++;
    if (done % 10 === 0 || done === total) {
      console.log(`  · ${done}/${total} готово (ошибок: ${errors.length})`);
    }
  }
}

// ── Параллельный рендер ──
const limit = pLimit(CONCURRENCY);
const ids = [];
for (let i = FROM_ID; i <= TO_ID; i++) ids.push(i);

await Promise.all(ids.map((id) => limit(() => renderOne(id))));

await browser.close();

console.log(`\n✅ Рендер завершён: успешно ${successIds.length}, ошибок ${errors.length}`);

// Сохраняем ошибки
await fs.writeFile(ERR_PATH, JSON.stringify(errors, null, 2), 'utf8');

// ── Сборка PDF из PNG ──
console.log('\n📦 Собираю PDF…');
const pdf = await PDFDocument.create();
successIds.sort((a, b) => a - b);

let added = 0;
for (const id of successIds) {
  const pngPath = path.join(PNG_DIR, `${String(id).padStart(4, '0')}.png`);
  try {
    const bytes = await fs.readFile(pngPath);
    const img = await pdf.embedPng(bytes);
    // A4 landscape в points (1pt = 1/72 in). A4 = 297×210 mm = 842×595 pt
    const pageW = 842;
    const pageH = 595;
    const page = pdf.addPage([pageW, pageH]);
    // Вписываем картинку с сохранением пропорций
    const scale = Math.min(pageW / img.width, pageH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: (pageW - w) / 2,
      y: (pageH - h) / 2,
      width: w,
      height: h,
    });
    added++;
    if (added % 50 === 0) console.log(`  · ${added}/${successIds.length} страниц добавлено`);
  } catch (e) {
    errors.push({ id, error: 'pdf embed: ' + e.message });
  }
}

const pdfBytes = await pdf.save();
await fs.writeFile(PDF_PATH, pdfBytes);
console.log(`✅ PDF готов: ${PDF_PATH} (${added} страниц)`);

// Финальный лог
await fs.writeFile(ERR_PATH, JSON.stringify(errors, null, 2), 'utf8');
if (errors.length) {
  console.log(`\n⚠️  Ошибок: ${errors.length}. Лог: ${ERR_PATH}`);
}
