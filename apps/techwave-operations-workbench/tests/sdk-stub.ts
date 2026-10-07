export enum FieldType {
  Text = 1,
  Number = 2,
  DateTime = 5,
  Formula = 20,
}

export enum OperationType {
  Editable = "editable",
}

export enum PermissionEntity {
  Table = "Table",
}

export enum ToastType {
  info = "info",
  success = "success",
  warning = "warning",
  error = "error",
  loading = "loading",
}

const unavailable = async () => { throw new Error("SDK stub: unavailable in isolated test"); };

export const bitable = {
  base: {
    getSelection: unavailable,
    getTableById: unavailable,
    getTableByName: unavailable,
    getPermission: unavailable,
  },
  bridge: { getData: unavailable, setData: unavailable },
  ui: { showToast: unavailable },
};
