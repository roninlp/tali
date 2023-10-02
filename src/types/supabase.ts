export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      categories: {
        Row: {
          created_at: string;
          id: number;
          name: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: number;
          name?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: number;
          name?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "categories_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      projects: {
        Row: {
          created_at: string;
          id: number;
          name: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: number;
          name?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: number;
          name?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          category_id: number | null;
          created_at: string;
          date: string;
          id: number;
          is_complete: boolean;
          project_id: number;
          title: string | null;
          user_id: string;
        };
        Insert: {
          category_id?: number | null;
          created_at?: string;
          date: string;
          id?: number;
          is_complete?: boolean;
          project_id: number;
          title?: string | null;
          user_id: string;
        };
        Update: {
          category_id?: number | null;
          created_at?: string;
          date?: string;
          id?: number;
          is_complete?: boolean;
          project_id?: number;
          title?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_category_id_fkey";
            columns: ["category_id"];
            referencedRelation: "categories";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_project_id_fkey";
            columns: ["project_id"];
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type InsertTables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
