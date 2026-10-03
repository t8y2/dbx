export interface FavoriteTarget {
  connectionId: string;
  catalog: string;
  database: string;
  schema: string;
  objectType: "table";
  objectName: string;
}

export interface TableFavorite extends FavoriteTarget {
  id: string;
  code: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTableFavorite {
  target: FavoriteTarget;
  name: string;
  code?: string;
}

export interface CreatedTableFavorite {
  item: TableFavorite;
  created: boolean;
}

export interface UpdateTableFavorite {
  name: string;
  code: string;
  expectedRevision: number;
}

export interface RelinkTableFavorite {
  target: FavoriteTarget;
  expectedRevision: number;
}

export interface TableFavorites {
  items: TableFavorite[];
  nextCode?: string;
}
