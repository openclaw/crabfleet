export const initialActionDialogState = {
  nextId: 1,
  dialog: null,
};

export function actionDialogReducer(state, action) {
  switch (action.type) {
    case "open":
      return {
        nextId: state.nextId + 1,
        dialog: {
          id: state.nextId,
          pending: false,
          error: "",
          ...action.options,
        },
      };
    case "close":
      return state.dialog?.pending ? state : { ...state, dialog: null };
    case "start":
      return updateDialog(state, action.id, (dialog) => ({
        ...dialog,
        pending: true,
        error: "",
      }));
    case "resolve":
      return state.dialog?.id === action.id ? { ...state, dialog: null } : state;
    case "reject":
      return updateDialog(state, action.id, (dialog) => ({
        ...dialog,
        pending: false,
        error: action.message || "The action could not be completed.",
      }));
    default:
      return state;
  }
}

function updateDialog(state, id, update) {
  return state.dialog?.id === id ? { ...state, dialog: update(state.dialog) } : state;
}
