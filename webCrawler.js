import axios from 'axios';
import cheerio from 'cheerio';
import turndown from 'turndown';
import fs from 'fs-extra';
import * as path from 'path';
import yargs from 'yargs';
const visitedPages = new Set();
const imageDownloads = new Set();
const y = yargs(process.argv.slice(2));
const argv = y
    .option('domain', {
    alias: 'd',
    describe: 'Domain name to crawl',
    demandOption: true,
    type: 'string',
})
    .help()
    .alias('help', 'h').argv;
const { domain } = await argv;
const turndownService = new turndown();
async function downloadAndSavePage(url, filename) {
    try {
        const response = await axios.get(url, { responseType: 'stream' });
        const stream = response.data;
        const chunks = [];
        stream.on('data', (chunk) => {
            chunks.push(chunk);
        });
        stream.on('end', async () => {
            const htmlContent = Buffer.concat(chunks).toString('utf-8');
            const $ = cheerio.load(htmlContent);
            const markdownContent = turndownService.turndown($.html());
            // Save the page as markdown with the title "index".
            await fs.writeFile(filename, markdownContent);
            console.log(`Downloaded and saved ${url} as ${filename}`);
            // Extract image links and download images.
            $('img').each(async (index, element) => {
                const imgSrc = $(element).attr('src');
                if (imgSrc) {
                    const imgFilename = path.basename(imgSrc);
                    const localImgPath = path.join(path.dirname(filename), imgFilename);
                    if (!imageDownloads.has(imgSrc)) {
                        await downloadImage(imgSrc, localImgPath);
                        imageDownloads.add(imgSrc);
                    }
                    // Update the image link in the markdown.
                    const imgTag = $(element).prop('outerHTML');
                    const updatedImgTag = imgTag.replace(imgSrc, imgFilename);
                    $('img').eq(index).replaceWith(updatedImgTag);
                }
            });
            // Save the modified markdown content.
            await fs.writeFile(filename, $.html());
        });
    }
    catch (error) {
        const axiosError = error;
        console.error(`Failed to download and save ${url}: ${axiosError.message}`);
    }
}
async function downloadImage(url, filename) {
    try {
        const response = await axios.get(url, { responseType: 'stream' });
        const writeStream = fs.createWriteStream(filename);
        response.data.pipe(writeStream);
        await new Promise((resolve, reject) => {
            writeStream.on('finish', () => resolve());
            writeStream.on('error', (err) => reject(err));
        });
        console.log(`Downloaded and saved image ${url} as ${filename}`);
    }
    catch (error) {
        const axiosError = error;
        console.error(`Failed to download image ${url}: ${axiosError.message}`);
    }
}
function extractLocalPathFromUrl(url) {
    try {
        const urlObject = new URL(url);
        return urlObject.pathname;
    }
    catch (error) {
        console.error(`Invalid URL: ${url}`);
        return null;
    }
}
function pathSegmentToFilename(pathSegment) {
    // Remove leading and trailing dashes and collapse consecutive dashes.
    const cleanedPath = pathSegment.replace(/(^-+|-+$)/g, '').replace(/-+/g, '-');
    // Replace non-alphabetical characters with dashes.
    let sanitizedPath = cleanedPath.replace(/[^a-zA-Z]/g, '-');
    if (sanitizedPath.length === 0) {
        return 'index';
    }
    if (sanitizedPath.startsWith('-'))
        sanitizedPath = sanitizedPath.substring(1);
    if (sanitizedPath.endsWith('-'))
        sanitizedPath = sanitizedPath.substring(0, sanitizedPath.length - 1);
    return sanitizedPath;
}
async function crawl(url, baseFolder) {
    const pagePath = extractLocalPathFromUrl(url);
    const pageFileName = pathSegmentToFilename(pagePath || '') + '.mdx';
    if (!visitedPages.has(pageFileName)) {
        visitedPages.add(pageFileName);
        const fileName = path.join(baseFolder, pageFileName);
        await downloadAndSavePage(url, fileName);
        try {
            const response = await axios.get(url);
            const $ = cheerio.load(response.data);
            const domainRegex = new RegExp(`^https?://(www\\.)?${domain}`);
            const folderName = path.join('results', domain);
            $('a').each(async (index, element) => {
                const link = $(element).attr('href');
                if (link && link.match(domainRegex)) {
                    const absoluteUrl = link.startsWith('http') ? link : `https://${link}`;
                    await crawl(absoluteUrl, folderName);
                }
            });
        }
        catch (error) {
            const axiosError = error;
            console.error(`Failed to crawl ${url}: ${axiosError.message}`);
        }
    }
}
// Create the output directory for the domain.
fs.ensureDirSync(path.join('results', domain));
// Start the crawl with the provided domain.
crawl(`https://${domain}`, path.join('results', domain));
