// ─────────────────────────────────────────────────────────────────────────────
// Gulpfile (Windows-safe ImageMagick + watermark bar; reads EXIF from original)
// ─────────────────────────────────────────────────────────────────────────────

const gulp = require('gulp');
const sass = require('gulp-sass')(require('sass'));
const uglify = require('gulp-uglify');
const rename = require('gulp-rename');
const del = require('del');
const log = require('fancy-log');

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Cleanup originals if you want (keeps subfolders)
gulp.task('delete', function () {
  return del(['images/*.*', 'images/temp_*']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function ensureMagick() {
  try { await execAsync('magick -version'); }
  catch { throw new Error('❌ ImageMagick not found. Install it and ensure `magick` is on PATH.'); }
}

function rationalToFloat(s) {
  if (!s) return null;
  if (s.includes('/')) {
    const [a, b] = s.split('/').map(Number);
    if (b) return a / b;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function readExif(origPath) {
  // Multiple fallbacks for each field (some cameras fill different tags)
  const fmt = [
    '%[EXIF:Model]',                  // 1
    '%[EXIF:FNumber]',                // 2
    '%[EXIF:ApertureValue]',          // 3
    '%[EXIF:ExposureTime]',           // 4
    '%[EXIF:ShutterSpeedValue]',      // 5 (Apex)
    '%[EXIF:ISOSpeedRatings]',        // 6
    '%[EXIF:PhotographicSensitivity]' // 7
  ].join('|');

  const { stdout } = await execAsync(`magick identify -format "${fmt}" "${origPath}"`);
  let [model, fnum, av, exp, ssv, isoA, isoB] = (stdout || '').trim().split('|').map(s => (s || '').trim());

  // F-number
  let fNumber = fnum;
  if (!fNumber && av) {
    const avFloat = rationalToFloat(av);
    if (avFloat != null) fNumber = (Math.pow(Math.SQRT2, avFloat)).toFixed(1).replace(/\.0$/, '');
  }
  if (fNumber && fNumber.includes('/')) {
    const rf = rationalToFloat(fNumber);
    if (rf != null) fNumber = rf.toFixed(1).replace(/\.0$/, '');
  }

  // Exposure
  let exposure = exp;
  if (!exposure && ssv) {
    // ShutterSpeedValue in APEX units: Tv = log2(1/t) => t = 2^(-Tv)
    const tv = rationalToFloat(ssv);
    if (tv != null) {
      const t = Math.pow(2, -tv);
      exposure = t < 1 ? `1/${Math.round(1 / t)}` : `${t.toFixed(1).replace(/\.0$/, '')}s`;
    }
  }
  if (exposure && !exposure.includes('/')) {
    const t = Number(exposure);
    if (Number.isFinite(t)) exposure = t < 1 ? `1/${Math.round(1 / t)}` : `${t}s`;
  }

  const iso = (isoA || isoB || '').toString();
  return { model: model || 'Camera', fNumber: fNumber || '', exposure: exposure || '', iso };
}

async function imageDims(p) {
  const { stdout } = await execAsync(`magick identify -format "%w %h" "${p}"`);
  const [w, h] = (stdout || '0 0').trim().split(/\s+/).map(Number);
  return { w, h };
}

async function addWatermark(inputPath, outputPath, exifInfo, pointSizeOverride) {
  const { w, h } = await imageDims(inputPath);
  const ps = pointSizeOverride || Math.max(14, Math.round(w * 0.028));
  const barHeight = Math.max(50, Math.round(ps * 2.2));
  const y0 = Math.max(0, h - barHeight);

  const parts = [
    `📷 ${exifInfo.model}`,
    exifInfo.fNumber ? `● f/${exifInfo.fNumber}` : null,
    exifInfo.exposure ? `● ${exifInfo.exposure}` : null,
    exifInfo.iso ? `● ISO ${exifInfo.iso}` : null
  ].filter(Boolean);
  const text = parts.join('   ');

  const cmd = [
    'magick',
    `"${inputPath}"`,
    '-fill "#00000080"',
    `-draw "rectangle 0,${y0} ${w},${h}"`,
    '-gravity southwest',
    `-pointsize ${ps}`,
    '-kerning 1',
    '-fill white',
    `-annotate +20+${Math.round(barHeight * 0.35)} "${text.replace(/(["\\])/g, '\\$1')}"`,
    `"${outputPath}"`
  ].join(' ');

  await execAsync(cmd);
}

// ─────────────────────────────────────────────────────────────────────────────
// Resize + watermark
// ─────────────────────────────────────────────────────────────────────────────
gulp.task('resize-images', async function () {
  await ensureMagick();

  if (!fs.existsSync('images')) {
    log.error('❌ Images directory missing');
    return;
  }

  const files = fs.readdirSync('images').filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
  if (files.length === 0) {
    log.warn('⚠️ No images found in images/ directory');
    return;
  }

  log.info(`🔄 Processing ${files.length} images...`);
  if (!fs.existsSync('images/fulls')) fs.mkdirSync('images/fulls', { recursive: true });
  if (!fs.existsSync('images/thumbs')) fs.mkdirSync('images/thumbs', { recursive: true });

  for (const file of files) {
    const orig = path.join('images', file);
    const temp = path.join('images', `temp_${file}`);
    const outFull  = path.join('images/fulls', file);
    const outThumb = path.join('images/thumbs', file);

    log.info(`Processing ${file}...`);
    try {
      // 1) Read EXIF from ORIGINAL (before strip)
      const exif = await readExif(orig);

      // 2) Normalise (auto-orient + strip), then resize
      await execAsync(`magick identify -verbose "${orig}"`);
      await execAsync(`magick "${orig}" -auto-orient -strip "${temp}"`);

      const tempFull  = path.join('images', `temp_full_${file}`);
      const tempThumb = path.join('images', `temp_thumb_${file}`);
      await execAsync(`magick "${temp}" -resize 1024x1024 "${tempFull}"`);
      await execAsync(`magick "${temp}" -resize 512x512 "${tempThumb}"`);

      // 3) Watermark using EXIF from original
      await addWatermark(tempFull,  outFull,  exif);

      fs.copyFileSync(tempThumb, outThumb);

      // 4) Cleanup
      [temp, tempFull, tempThumb].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
      log.info(`✅ Done: ${file}`);
    } catch (err) {
      log.error(`❌ Failed to process ${file}: ${err.message}`);
      try {
        const exif = await readExif(orig); // try again for fallback
        log.warn(`⚠️ Fallback (direct resize + watermark) for ${file}...`);
        await execAsync(`magick "${orig}" -resize 1024x1024 -quality 80 "${outFull}"`);
        await execAsync(`magick "${orig}" -resize 512x512  -quality 70 "${outThumb}"`);
        await addWatermark(outFull,  outFull,  exif);
        await addWatermark(outThumb, outThumb, exif, 14);
        log.info(`✅ Fallback succeeded: ${file}`);
      } catch (fallbackErr) {
        log.error(`❌ Fallback failed for ${file}: ${fallbackErr.message}`);
        fs.writeFileSync(outFull,  `ERROR PROCESSING: ${file}\n${err.message}`);
        fs.writeFileSync(outThumb, `ERROR PROCESSING: ${file}\n${err.message}`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Front-end build
// ─────────────────────────────────────────────────────────────────────────────
gulp.task('sass', function () {
  return gulp.src('./assets/sass/main.scss')
    .pipe(sass({ outputStyle: 'compressed' }).on('error', sass.logError))
    .pipe(rename({ basename: 'main.min' }))
    .pipe(gulp.dest('./assets/css'));
});

gulp.task('sass:watch', function () {
  gulp.watch('./assets/sass/**/*.scss', gulp.series('sass'));
});

gulp.task('minify-js', function () {
  return gulp.src('./assets/js/main.js')
    .pipe(uglify())
    .pipe(rename({ basename: 'main.min' }))
    .pipe(gulp.dest('./assets/js'));
});

gulp.task('build', gulp.series('sass', 'minify-js'));
gulp.task('resize', gulp.series('resize-images', 'delete'));
gulp.task('default', gulp.series('build', 'resize'));
