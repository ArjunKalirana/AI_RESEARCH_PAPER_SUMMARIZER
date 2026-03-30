class Annotator {
    constructor() {
        this.paperId = new URLSearchParams(window.location.search).get('paperId');
        if (!this.paperId) return;
        
        this.annotations = JSON.parse(localStorage.getItem(`annotations_${this.paperId}`)) || [];
        this.setupUI();
        this.bindEvents();
        setTimeout(() => this.applyAnnotations(), 1000);
        window.applyAnnotations = () => this.applyAnnotations();
    }

    setupUI() {
        // Toolbar
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'fixed z-[100] hidden bg-slate-900 border border-slate-700 rounded-full px-2 py-1 shadow-xl flex items-center gap-1 transition-opacity opacity-0';
        this.toolbar.innerHTML = `
            <button id="anno-highlight" class="p-2 hover:bg-slate-800 rounded-full text-slate-300 hover:text-yellow-400 transition-colors" title="Highlight">
                🖍️
            </button>
            <button id="anno-note" class="p-2 hover:bg-slate-800 rounded-full text-slate-300 hover:text-white transition-colors" title="Add Note">
                📝
            </button>
        `;
        document.body.appendChild(this.toolbar);

        // Sidebar
        this.sidebar = document.createElement('div');
        this.sidebar.className = 'fixed right-0 top-16 bottom-0 w-80 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 transform translate-x-full transition-transform duration-300 z-40 flex flex-col shadow-2xl';
        this.sidebar.innerHTML = `
            <div class="px-6 flex items-center justify-between h-14 border-b border-slate-100 dark:border-slate-800">
                <h3 class="font-bold text-sm">📌 My Annotations (<span id="anno-count">0</span>)</h3>
                <button id="anno-close" class="text-xl font-medium text-slate-400 hover:text-slate-900 dark:hover:text-white leading-none">
                    ✕
                </button>
            </div>
            <div id="anno-list" class="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar"></div>
        `;
        document.body.appendChild(this.sidebar);

        // Sidebar Toggle Button
        this.toggleBtn = document.createElement('button');
        this.toggleBtn.className = 'fixed right-6 bottom-24 w-12 h-12 bg-primary text-white rounded-full shadow-lg hover:scale-105 active:scale-95 transition-all z-40 flex items-center justify-center';
        this.toggleBtn.innerHTML = '🔖';
        document.body.appendChild(this.toggleBtn);
        
        // Note Input Modal
        this.noteModal = document.createElement('div');
        this.noteModal.className = 'fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[200] hidden items-center justify-center p-4';
        this.noteModal.innerHTML = `
            <div class="bg-white dark:bg-slate-900 w-full max-w-sm rounded-2xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800">
                <h4 class="font-bold text-sm mb-3">Add Annotation Note</h4>
                <textarea id="anno-note-text" class="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl p-3 text-sm resize-none mb-3 focus:ring-2 focus:ring-primary/20 outline-none" rows="3" placeholder="Type your note here..."></textarea>
                <div class="flex justify-end gap-2">
                    <button id="anno-note-cancel" class="px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">CANCEL</button>
                    <button id="anno-note-save" class="px-4 py-2 text-xs font-bold bg-primary text-white rounded-lg hover:opacity-90 transition-opacity">SAVE NOTE</button>
                </div>
            </div>
        `;
        document.body.appendChild(this.noteModal);

        this.updateSidebar();
    }

    bindEvents() {
        document.addEventListener('mouseup', (e) => {
            if (this.toolbar.contains(e.target) || this.sidebar.contains(e.target)) return;
            
            setTimeout(() => {
                const selection = window.getSelection();
                const text = selection.toString().trim();
                
                if (text.length > 0) {
                    const range = selection.getRangeAt(0);
                    const rect = range.getBoundingClientRect();
                    
                    this.toolbar.style.left = `${rect.left + (rect.width / 2) - (this.toolbar.offsetWidth / 2)}px`;
                    this.toolbar.style.top = `${rect.top - 50 + window.scrollY}px`;
                    this.toolbar.classList.remove('hidden');
                    // slight delay for animation
                    setTimeout(() => this.toolbar.classList.remove('opacity-0'), 10);
                    
                    this.currentSelection = {
                        text: text,
                        range: range.cloneRange()
                    };
                } else {
                    this.hideToolbar();
                }
            }, 10);
        });

        document.getElementById('anno-highlight').onclick = () => this.addAnnotation(null);
        document.getElementById('anno-note').onclick = () => this.showNoteModal();
        
        document.getElementById('anno-note-cancel').onclick = () => {
            this.noteModal.classList.replace('flex', 'hidden');
            this.hideToolbar();
        };
        
        document.getElementById('anno-note-save').onclick = () => {
            const note = document.getElementById('anno-note-text').value;
            this.addAnnotation(note);
            this.noteModal.classList.replace('flex', 'hidden');
        };

        this.toggleBtn.onclick = () => this.sidebar.classList.toggle('translate-x-full');
        document.getElementById('anno-close').onclick = () => this.sidebar.classList.add('translate-x-full');
    }

    showNoteModal() {
        document.getElementById('anno-note-text').value = '';
        this.noteModal.classList.replace('hidden', 'flex');
        document.getElementById('anno-note-text').focus();
    }

    hideToolbar() {
        this.toolbar.classList.add('opacity-0');
        setTimeout(() => {
            if (this.toolbar.classList.contains('opacity-0')) {
                this.toolbar.classList.add('hidden');
            }
        }, 200);
        this.currentSelection = null;
    }

    addAnnotation(note) {
        if (!this.currentSelection) return;

        const id = 'anno_' + Date.now().toString(36);
        const newAnno = {
            id,
            text: this.currentSelection.text,
            note: note,
            timestamp: Date.now()
        };

        this.annotations.push(newAnno);
        this.saveAnnotations();
        
        // Try to apply immediately via range extraction if possible,
        // but fallback to full document re-apply
        window.getSelection().removeAllRanges();
        this.hideToolbar();
        this.applyAnnotations();
        this.updateSidebar();
    }

    saveAnnotations() {
        localStorage.setItem(`annotations_${this.paperId}`, JSON.stringify(this.annotations));
    }

    deleteAnnotation(id) {
        this.annotations = this.annotations.filter(a => a.id !== id);
        this.saveAnnotations();
        
        // Remove highlighting from DOM by replacing the mark with its contents
        const marks = document.querySelectorAll(`mark[data-anno-id="${id}"]`);
        marks.forEach(mark => {
           const parent = mark.parentNode;
           while(mark.firstChild) parent.insertBefore(mark.firstChild, mark);
           parent.removeChild(mark);
        });
        
        this.updateSidebar();
    }

    applyAnnotations() {
        // Simple DOM traversal to wrap text. 
        // Note: For robust production, use a library like mark.js.
        // Doing basic string injection on specific containers.
        const containers = document.querySelectorAll('.prose'); // Target specific areas
        
        if (containers.length === 0 || this.annotations.length === 0) return;

        containers.forEach(container => {
            // Un-mark existing first to avoid nesting loops
            this.annotations.forEach(anno => {
                if(!container.innerHTML.includes(`data-anno-id="${anno.id}"`)) {
                     // Very naive replacement. Works for simple text, fails if text contains HTML
                     // We escape special regex chars in text
                     const escapedText = anno.text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                     // Find text not inside HTML tags
                     const regex = new RegExp(`(?<!<[^>]*)(${escapedText})`, 'gi');
                     
                     let noteAttr = anno.note ? `title="${anno.note.replace(/"/g, '&quot;')}"` : '';
                     let tooltipClass = anno.note ? 'cursor-help border-b border-dashed border-yellow-600' : '';
                     
                     container.innerHTML = container.innerHTML.replace(regex, (match) => {
                         // Only replace if it's not already wrapped
                         if(match.includes('mark data-anno-id')) return match;
                         return `<mark data-anno-id="${anno.id}" class="bg-yellow-200 dark:bg-yellow-900/60 text-inherit rounded px-1 transition-all hover:bg-yellow-300 dark:hover:bg-yellow-800 ${tooltipClass}" ${noteAttr}>${match}</mark>`;
                     });
                }
            });
        });
    }

    updateSidebar() {
        document.getElementById('anno-count').textContent = this.annotations.length;
        const list = document.getElementById('anno-list');
        list.innerHTML = '';

        if (this.annotations.length === 0) {
            list.innerHTML = '<div class="text-sm text-slate-400 text-center py-8 italic">No annotations yet. Select text to add one.</div>';
            return;
        }

        // Sort latest first
        [...this.annotations].sort((a,b) => b.timestamp - a.timestamp).forEach(anno => {
            const item = document.createElement('div');
            item.className = 'group bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 rounded-xl p-3 relative';
            item.innerHTML = `
                <div class="text-xs text-slate-800 dark:text-slate-200 line-clamp-3 mb-2 px-1 border-l-2 border-yellow-400 pl-2">${anno.text}</div>
                ${anno.note ? `<div class="bg-white dark:bg-slate-900 text-xs text-slate-600 dark:text-slate-400 p-2 rounded-lg border border-slate-100 dark:border-slate-800 flex gap-2"><span>💬</span><span>${anno.note}</span></div>` : ''}
                <div class="mt-2 flex justify-between items-center">
                    <span class="text-[10px] text-slate-400 font-medium">${new Date(anno.timestamp).toLocaleDateString()}</span>
                    <button class="anno-del-btn text-slate-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100" data-id="${anno.id}">
                        🗑
                    </button>
                </div>
            `;
            list.appendChild(item);
        });

        document.querySelectorAll('.anno-del-btn').forEach(btn => {
            btn.onclick = (e) => this.deleteAnnotation(e.currentTarget.dataset.id);
        });
    }
}

// Auto-initialize
document.addEventListener('DOMContentLoaded', () => {
    window.researchAnnotator = new Annotator();
});
