import { createContext, useContext, type ReactNode } from 'react';

export interface QolCanvasState {
  reorderMode: boolean;
  reorderOrder: Record<string, number>;
  reorderNextNumber: number;
  reorderTotal: number;
  readingOrderMap: Record<string, number>;
  onReorderClick: (id: string) => void;
  onFinishReorder: () => void;
  overflowIds: Set<string>;
  selectedTextIds: Set<string>;
  onTextMultiSelect: (id: string, multi: boolean) => void;
  boxOpsNode?: ReactNode;
}

export const QolCanvasContext = createContext<QolCanvasState | null>(null);
export const useQolCanvas = () => useContext(QolCanvasContext);
