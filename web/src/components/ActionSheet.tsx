import { BottomSheet } from "./BottomSheet";

export interface ActionSheetAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

interface ActionSheetProps {
  title?: string;
  actions: ActionSheetAction[];
  onClose: () => void;
}

export function ActionSheet({ title, actions, onClose }: ActionSheetProps) {
  return (
    <BottomSheet onClose={onClose}>
      {title !== undefined && (
        <div className="px-[20px] pb-[10px] text-[13px] font-semibold text-txt-bright">{title}</div>
      )}
      <div className="flex flex-col pb-[6px]">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              action.onSelect();
              onClose();
            }}
            className={`px-[20px] py-[14px] text-left text-[14px] ${
              action.danger === true ? "text-diff-removed" : "text-txt-bright"
            } hover:bg-raised`}
          >
            {action.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onClose}
          className="mt-[6px] border-t border-border px-[20px] py-[14px] text-left text-[14px] text-txt-dim hover:bg-raised"
        >
          Cancel
        </button>
      </div>
    </BottomSheet>
  );
}
