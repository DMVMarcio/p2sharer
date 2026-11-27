import { DocumentFilesDialog, type NoteExportFormat, type SavedNote } from '../shared/DocumentFilesDialog';

interface NotepadFilesProps {
  mode: 'open' | 'save' | 'export'; initialName: string;
  onOpen: (note: SavedNote | { content: string; format: string }) => void;
  onSave: (name: string, overwrite?: SavedNote) => Promise<void>;
  onRename: (note: SavedNote) => void;
  onDelete: (id: string) => void;
  onExport: (format: NoteExportFormat) => Promise<void>;
  onClose: () => void;
}
export function NotepadFilesDialog(props: NotepadFilesProps) {
  return <DocumentFilesDialog {...props} onExport={format => props.onExport(format as NoteExportFormat)} />;
}
