const puppeteer = require("puppeteer");
const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const path = require("path");
const { PDFDocument } = require('pdf-lib');

const URL_GITBOOK = "https://renownedgames.gitbook.io/ai-tree";

// Function to fetch the sitemap XML and parse it
async function fetchSitemap(url) {
  try {
    console.log('Fetching sitemap from:', url);
    const response = await axios.get(url);
    if (!response.data) {
      throw new Error('No data received from sitemap URL');
    }

    console.log('Parsing XML response...');
    const result = await xml2js.parseStringPromise(response.data);
    console.log('Parsed XML structure:', JSON.stringify(result, null, 2));

    // Handle different possible XML structures
    if (result && result.urlset && Array.isArray(result.urlset.url)) {
      return result.urlset.url.map(urlData => {
        if (!urlData || !urlData.loc || !urlData.loc[0]) {
          console.warn('Skipping invalid URL entry:', urlData);
          return null;
        }
        return urlData.loc[0];
      }).filter(url => url !== null);
    } else if (result && result.sitemapindex && Array.isArray(result.sitemapindex.sitemap)) {
      // Handle sitemap index file
      console.log('Found sitemap index, fetching first sitemap...');
      const firstSitemap = result.sitemapindex.sitemap[0].loc[0];
      return fetchSitemap(firstSitemap);
    } else {
      console.error('Unexpected XML structure:', result);
      throw new Error('Invalid sitemap format - unexpected XML structure');
    }
  } catch (error) {
    console.error('Error fetching or parsing sitemap:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

// Function to convert a page to PDF with selectable text and high-quality images
async function takeFullPagePdf(page, url, outputPath) {
  try {
    // Set the viewport to a reasonable width (e.g., 1280px) for full-page capture
    await page.setViewport({ width: 1280, height: 800 });

    // Set device scale factor for high DPI (2 is Retina)
    await page.emulate({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      userAgent: "",
    });

    // Go to the page and wait for it to load completely
    await page.goto(url, { waitUntil: "networkidle2" });

    // Remove elements by setting display to 'none'
    await page.evaluate(() => {
      // Remove the AppBar element
      const appBar = document.querySelector("div.appBarClassName"); // Replace with the correct selector for the AppBar
      if (appBar) {
        appBar.style.display = "none"; // Hide the AppBar
      }

      // Remove the element with class "scroll-nojump"
      const scrollNoJump = document.querySelector(".scroll-nojump");
      if (scrollNoJump) {
        scrollNoJump.style.display = "none"; // Hide the scroll-nojump element
      }

      // Remove the menu element
      const menu = document.querySelector(
        "aside.relative.group.flex.flex-col.basis-full.bg-light"
      );
      if (menu) {
        menu.style.display = "none"; // Hide the menu
      }

      // Remove the search button
      const searchButton = document.querySelector(
        "div.flex.md\\:w-56.grow-0.shrink-0.justify-self-end"
      );
      if (searchButton) {
        searchButton.style.display = "none"; // Hide the search button div
      }

      // Remove the next button div
      const nextButton = document.querySelector(
        "div.flex.flex-col.md\\:flex-row.mt-6.gap-2.max-w-3xl.mx-auto.page-api-block\\:ml-0"
      );
      if (nextButton) {
        nextButton.style.display = "none"; // Hide the next button div
      }

      // Remove the "Last updated" info
      const lastUpdatedInfo = document.querySelector(
        "div.flex.flex-row.items-center.mt-6.max-w-3xl.mx-auto.page-api-block\\:ml-0"
      );
      if (lastUpdatedInfo) {
        lastUpdatedInfo.style.display = "none"; // Hide the "Last updated" div
      }
    });

    // Convert the page to PDF with high-quality images
    await page.pdf({
      path: outputPath,
      format: "A4", // Use A4 paper size for PDF
      printBackground: true, // Ensure background images and colors are included
      scale: 1, // Keep the original scale
      preferCSSPageSize: true, // Ensure that the page uses CSS page size
    });

    console.log(`Saved PDF for: ${url} at ${outputPath}`);
  } catch (error) {
    console.error(`Failed to take PDF for: ${url}`, error);
  }
}

// Function to group URLs based on their categories (like 'settings', 'android')
function categorizeUrl(url) {
  const parts = url.split("/");
  if (parts.length < 5) {
    console.error(`URL structure is incorrect: ${url}`);
    return "unknown"; // Return a fallback category
  }
  const category = parts[4]; // Assuming categories are the 5th part of the URL
  return category; // Return the category name (e.g., 'settings', 'android')
}

// Function to get site name from URL
function getSiteName(url) {
  const urlParts = url.split('/');
  // Get the last non-empty part of the URL
  return urlParts.filter(part => part).pop();
}

// Function to combine PDFs
async function combinePDFs(pdfPaths, outputPath) {
  try {
    const mergedPdf = await PDFDocument.create();
    
    for (const pdfPath of pdfPaths) {
      const pdfBytes = fs.readFileSync(pdfPath);
      const pdf = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach(page => mergedPdf.addPage(page));
    }

    const mergedPdfBytes = await mergedPdf.save();
    fs.writeFileSync(outputPath, mergedPdfBytes);
    console.log(`Combined PDF saved to: ${outputPath}`);
  } catch (error) {
    console.error('Error combining PDFs:', error);
  }
}

// Main function to run the script
async function run() {
  const sitemapUrl = `${URL_GITBOOK}/sitemap.xml`;
  const baseDir = "./pdfs";
  const siteName = getSiteName(URL_GITBOOK);
  const siteDir = path.join(baseDir, siteName);

  // Create base and site directories if they don't exist
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir);
  }
  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir);
  }

  // Fetch the sitemap URLs
  const urls = await fetchSitemap(sitemapUrl);
  if (!urls) return;

  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  const allPdfPaths = [];

  // Initialize the page counter
  let pageCounter = 1;

  // Loop through each URL in the sitemap
  for (const url of urls) {
    const category = categorizeUrl(url);
    const categoryDir = path.join(siteDir, category);

    if (!fs.existsSync(categoryDir)) {
      fs.mkdirSync(categoryDir, { recursive: true });
    }

    const pdfFileName = `page_${pageCounter}.pdf`;
    const pdfPath = path.join(categoryDir, pdfFileName);

    await takeFullPagePdf(page, url, pdfPath);
    allPdfPaths.push(pdfPath);
    pageCounter++;
  }

  await browser.close();

  // Create combined PDF
  const combinedPdfPath = path.join(siteDir, `${siteName}_combined.pdf`);
  await combinePDFs(allPdfPaths, combinedPdfPath);
}

run().catch(console.error);
