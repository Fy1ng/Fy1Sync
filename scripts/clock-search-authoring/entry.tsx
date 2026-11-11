import { createRoot } from 'react-dom/client'
import '../../src/studio/studio.css'
import { AuthorApp } from './AuthorApp'

const root = document.getElementById('root')
if (!root) throw new Error('缺少制作工具挂载点')
createRoot(root).render(<AuthorApp />)
