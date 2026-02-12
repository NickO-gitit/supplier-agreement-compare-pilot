import { useState } from 'react';
import { MessageSquare, Plus, Trash2, Edit2, Save, X, StickyNote } from 'lucide-react';
import type { Note, Difference } from '../types';
import { generateId } from '../services/storage';

interface NotesPanelProps {
  notes: Note[];
  selectedDiffId: string | null;
  differences: Difference[];
  onAddNote: (note: Note) => void;
  onUpdateNote: (note: Note) => void;
  onDeleteNote: (noteId: string) => void;
}

const CATEGORIES: { value: Note['category']; label: string; color: string; bgColor: string }[] = [
  { value: 'question', label: 'Question', color: 'text-blue-700', bgColor: 'bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200' },
  { value: 'concern', label: 'Concern', color: 'text-orange-700', bgColor: 'bg-gradient-to-br from-orange-50 to-amber-50 border-orange-200' },
  { value: 'approved', label: 'Approved', color: 'text-emerald-700', bgColor: 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200' },
  { value: 'rejected', label: 'Rejected', color: 'text-red-700', bgColor: 'bg-gradient-to-br from-red-50 to-rose-50 border-red-200' },
  { value: 'general', label: 'General', color: 'text-slate-700', bgColor: 'bg-gradient-to-br from-slate-50 to-gray-50 border-slate-200' },
];

export function NotesPanel({
  notes,
  selectedDiffId,
  differences,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
}: NotesPanelProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [newNoteContent, setNewNoteContent] = useState('');
  const [newNoteCategory, setNewNoteCategory] = useState<Note['category']>('general');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState<Note['category']>('general');

  // Filter notes: show notes for selected diff, or all notes if no diff selected
  const filteredNotes = selectedDiffId
    ? notes.filter((n) => n.differenceId === selectedDiffId)
    : notes;

  const handleAddNote = () => {
    if (!newNoteContent.trim()) return;

    const note: Note = {
      id: generateId(),
      differenceId: selectedDiffId,
      content: newNoteContent.trim(),
      category: newNoteCategory,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    onAddNote(note);
    setNewNoteContent('');
    setNewNoteCategory('general');
    setIsAdding(false);
  };

  const handleStartEdit = (note: Note) => {
    setEditingNoteId(note.id);
    setEditContent(note.content);
    setEditCategory(note.category);
  };

  const handleSaveEdit = (noteId: string) => {
    const note = notes.find((n) => n.id === noteId);
    if (!note || !editContent.trim()) return;

    onUpdateNote({
      ...note,
      content: editContent.trim(),
      category: editCategory,
      updatedAt: new Date(),
    });

    setEditingNoteId(null);
    setEditContent('');
  };

  const handleCancelEdit = () => {
    setEditingNoteId(null);
    setEditContent('');
  };

  const getDiffLabel = (diffId: string | null): string => {
    if (!diffId) return 'General';
    const index = differences.findIndex((d) => d.id === diffId);
    return index >= 0 ? `Change #${index + 1}` : 'Unknown';
  };

  const getCategoryStyle = (category: Note['category']) => {
    return CATEGORIES.find((c) => c.value === category) || CATEGORIES[4];
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StickyNote className="w-5 h-5 text-amber-500" />
          <div>
            <h3 className="font-semibold text-slate-800">Notes</h3>
            <p className="text-xs text-slate-500">
              {selectedDiffId ? 'For selected change' : 'All notes'}
            </p>
          </div>
        </div>
        {!isAdding && (
          <button
            onClick={() => setIsAdding(true)}
            className="p-2 bg-gradient-to-r from-indigo-500 to-purple-500 text-white rounded-xl hover:from-indigo-600 hover:to-purple-600 transition-all duration-200 shadow-md shadow-indigo-500/25"
            title="Add note"
          >
            <Plus className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Add Note Form */}
      {isAdding && (
        <div className="p-4 border-b border-slate-100 bg-gradient-to-br from-indigo-50 to-purple-50">
          <div className="mb-3">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Category</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setNewNoteCategory(cat.value)}
                  className={`px-3 py-1.5 text-sm rounded-xl border-2 transition-all duration-200 font-medium ${
                    newNoteCategory === cat.value
                      ? `${cat.bgColor} ${cat.color} border-current shadow-sm`
                      : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          <textarea
            value={newNoteContent}
            onChange={(e) => setNewNoteContent(e.target.value)}
            placeholder="Write your note..."
            className="w-full p-3 border-2 border-slate-200 rounded-xl resize-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all duration-200"
            rows={3}
            autoFocus
          />

          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={() => {
                setIsAdding(false);
                setNewNoteContent('');
              }}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-white rounded-xl transition-all duration-200"
            >
              Cancel
            </button>
            <button
              onClick={handleAddNote}
              disabled={!newNoteContent.trim()}
              className="px-4 py-2 text-sm font-medium bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl hover:from-indigo-700 hover:to-purple-700 transition-all duration-200 disabled:opacity-50 shadow-md shadow-indigo-500/25"
            >
              Add Note
            </button>
          </div>
        </div>
      )}

      {/* Notes List */}
      <div className="flex-1 overflow-auto">
        {filteredNotes.length === 0 ? (
          <div className="p-8 text-center">
            <div className="p-4 bg-slate-100 rounded-2xl inline-block mb-4">
              <MessageSquare className="w-10 h-10 text-slate-400" />
            </div>
            <p className="text-slate-500 text-sm">
              {selectedDiffId
                ? 'No notes for this change yet.'
                : 'No notes yet. Add a note to get started.'}
            </p>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            {filteredNotes.map((note) => {
              const style = getCategoryStyle(note.category);
              return (
                <div key={note.id} className={`p-4 rounded-xl border ${style.bgColor} transition-all duration-200 hover:shadow-md`}>
                  {editingNoteId === note.id ? (
                    /* Edit Mode */
                    <div>
                      <div className="mb-3 flex flex-wrap gap-2">
                        {CATEGORIES.map((cat) => (
                          <button
                            key={cat.value}
                            onClick={() => setEditCategory(cat.value)}
                            className={`px-2 py-1 text-xs rounded-lg border transition-all duration-200 font-medium ${
                              editCategory === cat.value
                                ? `${cat.bgColor} ${cat.color} border-current`
                                : 'bg-white border-slate-200 text-slate-600'
                            }`}
                          >
                            {cat.label}
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full p-3 border-2 border-slate-200 rounded-xl resize-none focus:ring-2 focus:ring-indigo-500 bg-white"
                        rows={3}
                      />
                      <div className="flex justify-end gap-2 mt-3">
                        <button
                          onClick={handleCancelEdit}
                          className="p-2 text-slate-500 hover:bg-white rounded-lg transition-all duration-200"
                        >
                          <X className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleSaveEdit(note.id)}
                          className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all duration-200"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* View Mode */
                    <>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`px-2.5 py-1 text-xs font-semibold rounded-lg ${style.color} bg-white/60`}>
                            {style.label}
                          </span>
                          {!selectedDiffId && note.differenceId && (
                            <span className="text-xs text-slate-400 font-medium">
                              {getDiffLabel(note.differenceId)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleStartEdit(note)}
                            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-white/60 rounded-lg transition-all duration-200"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDeleteNote(note.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all duration-200"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <p className="text-sm text-slate-700 whitespace-pre-wrap">{note.content}</p>
                      <p className="text-xs text-slate-400 mt-3 font-medium">
                        {note.updatedAt.toLocaleDateString()} at {note.updatedAt.toLocaleTimeString()}
                      </p>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Show all notes button when filtering */}
      {selectedDiffId && notes.length > filteredNotes.length && (
        <div className="p-3 border-t border-slate-100 bg-slate-50 text-center">
          <p className="text-xs text-slate-500 font-medium">
            Showing {filteredNotes.length} of {notes.length} total notes
          </p>
        </div>
      )}
    </div>
  );
}
