const gulp = require('gulp');
const imageResize = require('gulp-image-resize');
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


// Delete images before resizing (cleanup)
gulp.task('delete', function() {
    return del(['images/*.*']);
});

// Robust image processing using direct ImageMagick commands
gulp.task('resize-images', async function() {
    if (!fs.existsSync('images')) {
        log.error('❌ Images directory missing');
        return;
    }

    const files = fs.readdirSync('images').filter(file => 
        /\.(jpg|jpeg|png|gif|webp)$/i.test(file)
    );

    if (files.length === 0) {
        log.warn('⚠️ No images found in images/ directory');
        return;
    }

    log.info(`🔄 Processing ${files.length} images...`);
    
    // Ensure output directories exist
    if (!fs.existsSync('images/fulls')) fs.mkdirSync('images/fulls', { recursive: true });
    if (!fs.existsSync('images/thumbs')) fs.mkdirSync('images/thumbs', { recursive: true });

    for (const file of files) {
        const filePath = path.join('images', file);
        const fullSizePath = path.join('images/fulls', file);
        const thumbPath = path.join('images/thumbs', file);
        
        log.info(`Processing ${file}...`);
        
        try {
            // Step 1: Verify the image
            const { stdout: identifyOutput } = await execAsync(`identify -verbose "${filePath}"`);
            log.info(`✅ Verified: ${file}`);
            
            // Step 2: Convert to standard format first
            const tempPath = path.join('images', `temp_${file}`);
            await execAsync(`convert "${filePath}" -auto-orient -strip "${tempPath}"`);
            
            // Step 3: Create full size
            await execAsync(`convert "${tempPath}" -resize 1024x1024 -quality 80 "${fullSizePath}"`);
            log.info(`✅ Created full size: ${file}`);
            
            // Step 4: Create thumbnail
            await execAsync(`convert "${tempPath}" -resize 512x512 -quality 70 "${thumbPath}"`);
            log.info(`✅ Created thumbnail: ${file}`);
            
            // Cleanup temporary file
            fs.unlinkSync(tempPath);
        } catch (err) {
            log.error(`❌ Failed to process ${file}: ${err.message}`);
            
            // Try fallback method without conversion
            try {
                log.warn(`⚠️ Trying fallback method for ${file}...`);
                
                await execAsync(`convert "${filePath}" -resize 1024x1024 -quality 80 "${fullSizePath}"`);
                await execAsync(`convert "${filePath}" -resize 512x512 -quality 70 "${thumbPath}"`);
                
                log.info(`✅ Fallback succeeded for ${file}`);
            } catch (fallbackErr) {
                log.error(`❌ Fallback failed for ${file}: ${fallbackErr.message}`);
                
                // Create placeholder error files for debugging
                fs.writeFileSync(fullSizePath, `ERROR PROCESSING: ${file}\n${err.message}`);
                fs.writeFileSync(thumbPath, `ERROR PROCESSING: ${file}\n${err.message}`);
            }
        }
    }

    log.info('🎉 Finished processing all images');
});

// Compile SCSS to CSS
gulp.task('sass', function() {
    return gulp.src('./assets/sass/main.scss')
        .pipe(sass({outputStyle: 'compressed'}).on('error', sass.logError))
        .pipe(rename({basename: 'main.min'}))
        .pipe(gulp.dest('./assets/css'));
});

// Watch SCSS files
gulp.task('sass:watch', function() {
    gulp.watch('./assets/sass/**/*.scss', gulp.series('sass'));
});

// Minify JS
gulp.task('minify-js', function() {
    return gulp.src('./assets/js/main.js')
        .pipe(uglify())
        .pipe(rename({basename: 'main.min'}))
        .pipe(gulp.dest('./assets/js'));
});

// Build task
gulp.task('build', gulp.series('sass', 'minify-js'));

// Resize task - now resizes first, then resize
gulp.task('resize', gulp.series('resize-images','delete'));

// Default task
gulp.task('default', gulp.series('build', 'resize'));
