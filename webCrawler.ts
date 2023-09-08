import axios, { AxiosError } from 'axios';
import cheerio from 'cheerio';
import fs from 'fs-extra';
import * as path from 'path';
import yargs from 'yargs';
import TurndownService from 'turndown';

const visitedPages: Set<string> = new Set();
const imageDownloads: Set<string> = new Set();

const maxPages = 1000000;

// Ignore any files that contain these strings in their path.
const ignorePatterns = [
  'Admin',
  'MyPages',
  'PassWord',
  'MyChanges',
  'SandBox',
  'Search',
  '-revisions',
  '-showcode',
  '-raw',
  'Spam',
  'MySQL',
  '-edit',
  '-history',
  '-backlinks',
]

const y = yargs(process.argv.slice(2))
const argv = y
  .option('domain', {
    alias: 'd',
    describe: 'Domain name to crawl',
    demandOption: true,
    type: 'string',
  })
  .option('root', {
    alias: 'r',
    describe: 'Root element for Markdown content conversion',
    demandOption: false,
    type: 'string',
  })
  .option('clear', {
    alias: 'c',
    describe: 'Clear the output directory before crawling',
    demandOption: false,
    type: 'boolean',
  })
  .help()
  .alias('help', 'h').argv;

const { domain, root, clear } = await argv;

function elementToMDX(htmlContent:string, rootElement = 'body') {
  // Load the HTML content into cheerio.
  const $ = cheerio.load(htmlContent);

  // Get the root element contents as a html string.
  const rootElementContent = $(rootElement).html();

  if(!rootElementContent) return '';
  
  const turndownService = new TurndownService()

  const rawMD = turndownService.turndown(rootElementContent)

  // move any ![image](url "alt text") to ![alt text](url)
  const re = new RegExp('!\\[([^\\]]*)\\]\\(([^\\)]*)\\s"([^\\)]*)"\\)', 'gmu')
  const md = rawMD.replace(re, '![$1]($2)')

  return md
}

async function downloadAndSavePage(url: string, filename: string) {
  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const stream = response.data;

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on('end', async () => {
      const htmlContent = Buffer.concat(chunks).toString('utf-8');
      // Load the HTML content into cheerio.
      const $ = cheerio.load(htmlContent);

      // Extract image links and download images. 
      const images = $('img');
      for (let index = 0; index < images.length; index++) {
        const element = images[index];
        const imgSrc = $(element).attr('src');
        if (imgSrc) {
          const imgFilename = path.basename(imgSrc);
          const localImgPath = path.join(path.dirname(filename), imgFilename);
          if (!imageDownloads.has(imgSrc)) {
            await downloadImage(imgSrc, localImgPath);
            imageDownloads.add(imgSrc);
          }
          // Update the image link in the html.
          const imgTag = $(element).prop('outerHTML');
          const updatedImgTag = imgTag.replace(imgSrc, imgFilename);
          images.eq(index).replaceWith(updatedImgTag);

          // if the image has classes, we want to add them as text after the image
          // f.ex. <img class="classname"> -> <img class="classname">{.classname}
          const imgClasses = $(element).attr('class')
          if (imgClasses) {
            const imgClassList = imgClasses.split(' ')
            const imgClassText = imgClassList.map(c => `{.${c}}`).join('')
            const imgClassTextTag = `<p>${imgClassText}</p>`
            images.eq(index).after(imgClassTextTag)
          }
        }
      }

      // Extract links and update them to point to the local markdown files.
      const links = $('a');
      for (let index = 0; index < links.length; index++) {
        const element = links[index];
        const link = $(element).attr('href');
        if (link && link.includes(domain)) {
          const linkPath = extractLocalPathFromUrl(link);
          if (linkPath) {
            const linkFilename = pathSegmentToFilename(linkPath) + '.md';
            const localLinkPath = path.join(path.dirname(filename), linkFilename);
            // Update the link in the markdown.
            const linkTag = $(element).prop('outerHTML');
            const updatedLinkTag = linkTag.replace(link, linkFilename);
            links.eq(index).replaceWith(updatedLinkTag);
          }
        }
      }

      console.log(`Downloaded and saved ${url} as ${filename}`);
      const markdownContent = elementToMDX($.html(), root);

      // Save the modified markdown content.
      await fs.writeFile(filename, markdownContent);
    });
  } catch (error) {
    const axiosError = error as any as AxiosError
    console.error(`Failed to download and save ${url}: ${axiosError.message}`);
  }
}

async function downloadImage(url: string, filename: string) {
  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const writeStream = fs.createWriteStream(filename);
    response.data.pipe(writeStream);
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', (err) => reject(err));
    });
    console.log(`Downloaded and saved image ${url} as ${filename}`);
  } catch (error) {
    const axiosError = error as any as AxiosError
    console.error(`Failed to download image ${url}: ${axiosError.message}`);
  }
}

function extractLocalPathFromUrl(url: string): string | null {
  try {
    const urlObject = new URL(url);
    return urlObject.pathname;
  } catch (error) {
    console.error(`Invalid URL: ${url}`);
    return null;
  }
}

function toMekanismiURI (s: string): string {
  if (s === null) return ''
  // eslint-disable-next-line
  const re = new RegExp('[^a-öA-Ö0-9]', 'gmu')
  let r = s.replace(re, '-')
  while (r.includes('--')) {
    r = r.split('--').join('-')
  }
  // if the string ends with a -, remove it
  if (r.endsWith('-')) {
    r = r.slice(0, -1)
  }
  
  return r
}

function pathSegmentToFilename(pathSegment: string): string {
  // Remove leading and trailing dashes and collapse consecutive dashes.
  //const cleanedPath = pathSegment.replace(/(^-+|-+$)/g, '').replace(/-+/g, '-');
  
  // Replace non-alphabetical characters with dashes.
  //let sanitizedPath = cleanedPath.replace(/[^a-zA-Z]/g, '-');

  let sanitizedPath = toMekanismiURI(pathSegment)

  if (sanitizedPath.length === 0 || sanitizedPath === '-' ) {
    return 'index';
  }

  if (sanitizedPath.startsWith('-')) sanitizedPath = sanitizedPath.substring(1);
  if (sanitizedPath.endsWith('-')) sanitizedPath = sanitizedPath.substring(0, sanitizedPath.length - 1);
  
  return sanitizedPath;
}

async function crawl(url: string, baseFolder: string) {
  if (visitedPages.size >= maxPages) {
    return;
  }

  const pagePath = extractLocalPathFromUrl(url);
  const pageFileName = pathSegmentToFilename(pagePath || '') + '.md';

  if (!visitedPages.has(pageFileName)) {
    visitedPages.add(pageFileName);

    // Ignore any files that contain the ignore patterns in their path.
    if (ignorePatterns.some((pattern) => pageFileName.includes(pattern))) {
      console.log(`Ignoring ${url}`);
      return;
    }

    const fileName = path.join(
      baseFolder,
      pageFileName
    );

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
    } catch (error) {
      const axiosError = error as any as AxiosError
      console.error(`Failed to crawl ${url}: ${axiosError.message}`);
    }
  }
}

// Clear the output directory if requested.
if (clear) {
  fs.emptyDirSync(path.join('results', domain));
}
// Create the output directory for the domain.
fs.ensureDirSync(path.join('results', domain));

// Start the crawl with the provided domain.
crawl(`https://${domain}`, path.join('results', domain));
