import { createRoot } from 'react-dom/client';
import { PdfReaderApp } from '@/pdf/App';
import 'pdfjs-dist/web/pdf_viewer.css';
import '@/pdf/reader.css';

createRoot(document.getElementById('root')!).render(<PdfReaderApp />);
