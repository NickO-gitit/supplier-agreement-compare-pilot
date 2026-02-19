import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import Tesseract from 'tesseract.js';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type SupportedFileType = 'pdf' | 'docx' | 'xlsx' | 'txt' | 'jpg' | 'jpeg' | 'png';

export function getFileType(file: File): SupportedFileType | null {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const supportedTypes: SupportedFileType[] = ['pdf', 'docx', 'xlsx', 'txt', 'jpg', 'jpeg', 'png'];

  if (extension && supportedTypes.includes(extension as SupportedFileType)) {
    return extension as SupportedFileType;
  }
  return null;
}

export async function extractText(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  const fileType = getFileType(file);

  if (!fileType) {
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  switch (fileType) {
    case 'pdf':
      return extractFromPDF(file, onProgress);
    case 'docx':
      return extractFromDOCX(file, onProgress);
    case 'xlsx':
      return extractFromXLSX(file, onProgress);
    case 'txt':
      return extractFromTXT(file, onProgress);
    case 'jpg':
    case 'jpeg':
    case 'png':
      return extractFromImage(file, onProgress);
    default:
      throw new Error(`Unsupported file type: ${fileType}`);
  }
}

async function extractFromPDF(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const textParts: string[] = [];
  const totalPages = pdf.numPages;

  for (let i = 1; i <= totalPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => {
        if (!('str' in item)) {
          return '';
        }
        const suffix = 'hasEOL' in item && item.hasEOL ? '\n' : '';
        return `${item.str}${suffix}`;
      })
      .join(' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    textParts.push(pageText);

    if (onProgress) {
      onProgress((i / totalPages) * 100);
    }
  }

  return textParts.join('\n\n');
}

async function extractFromDOCX(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  if (onProgress) onProgress(10);

  const arrayBuffer = await file.arrayBuffer();
  if (onProgress) onProgress(50);

  const result = await mammoth.extractRawText({ arrayBuffer });
  if (onProgress) onProgress(100);

  return result.value;
}

async function extractFromXLSX(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  if (onProgress) onProgress(10);

  const arrayBuffer = await file.arrayBuffer();
  if (onProgress) onProgress(30);

  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  if (onProgress) onProgress(60);

  const textParts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const text = XLSX.utils.sheet_to_txt(sheet);
    textParts.push(`[Sheet: ${sheetName}]\n${text}`);
  }

  if (onProgress) onProgress(100);

  return textParts.join('\n\n');
}

async function extractFromTXT(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  if (onProgress) onProgress(50);
  const text = await file.text();
  if (onProgress) onProgress(100);
  return text;
}

async function extractFromImage(
  file: File,
  onProgress?: (progress: number) => void
): Promise<string> {
  const result = await Tesseract.recognize(file, 'eng', {
    logger: (m) => {
      if (m.status === 'recognizing text' && onProgress) {
        onProgress(m.progress * 100);
      }
    },
  });

  return result.data.text;
}
