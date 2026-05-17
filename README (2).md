# Render passports

GitHub Actions воркфлоу, который рендерит все паспорта в PNG и собирает один PDF.

## Установка (один раз)

1. В репозитории `Jane3dMp/4-` создай папки и положи файлы:
   ```
   .github/workflows/render-passports.yml
   scripts/package.json
   scripts/render.js
   ```
2. Сделай коммит.
3. На вкладке **Actions** включи воркфлоу, если выключен.

## Подготовка Apps Script

1. В Apps Script проекте → **Deploy** → **New deployment** → **Web app**.
2. **Execute as: Me**, **Who has access: Anyone** (без аутентификации).
3. Скопируй полный URL — будет вида `https://script.google.com/macros/s/AKfycb.../exec`.

## Запуск

1. В репо → **Actions** → **Render passports to PDF** → **Run workflow**.
2. Заполни:
   - **Web App URL**: тот URL из Apps Script (до `/exec`)
   - **from_id / to_id**: `1` / `881` (или меньший диапазон для теста)
   - **concurrency**: `4` (5-8 если хочется быстрее, но GoogleScript начнёт реджектить)
3. Жми **Run workflow**.

## Результат

После завершения (≈30-60 мин для 881 шт при concurrency=4):

- **passports-pdf** — `passports.pdf` со всеми страницами
- **passports-png** — все PNG отдельно (на случай если нужно перепечатать одну)
- **errors-log** — JSON со списком id, на которых упало

## Если упало

Скрипт сохраняет уже отрендеренные PNG. Можно перезапустить workflow с тем же диапазоном — он не будет повторно рендерить готовые. (PNG живут в artifacts только 14 дней — после этого нужно скачать и положить в репо, или запустить заново с нуля.)

## Тест перед боем

Сначала запусти с `from_id=396 to_id=396` (Александра — твой тестовый ребёнок). Скачай PNG из artifacts, посмотри визуально. Если ок — запускай 1…881.
