import { createRoot } from 'react-dom/client';
import { ConversionApp } from '../../conversion/App';
import '../../conversion/style.css';

createRoot(document.getElementById('root')!).render(<ConversionApp />);
