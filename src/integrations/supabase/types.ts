export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_secrets: {
        Row: {
          description: string | null
          key: string
          updated_at: string | null
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "app_secrets_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string | null
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          actor_id: string | null
          actor_role: Database["public"]["Enums"]["role"] | null
          after: Json | null
          at: string
          before: Json | null
          changed_columns: string[] | null
          department_id: string | null
          id: number
          reason: string | null
          row_id: string
          subject_profile_id: string | null
          table_name: string
          week_start: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["role"] | null
          after?: Json | null
          at?: string
          before?: Json | null
          changed_columns?: string[] | null
          department_id?: string | null
          id?: never
          reason?: string | null
          row_id: string
          subject_profile_id?: string | null
          table_name: string
          week_start?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          actor_id?: string | null
          actor_role?: Database["public"]["Enums"]["role"] | null
          after?: Json | null
          at?: string
          before?: Json | null
          changed_columns?: string[] | null
          department_id?: string | null
          id?: never
          reason?: string | null
          row_id?: string
          subject_profile_id?: string | null
          table_name?: string
          week_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      car_care_events: {
        Row: {
          car_id: string
          created_at: string
          department_id: string
          id: string
          kind: Database["public"]["Enums"]["car_care_kind"]
          note: string | null
          reported_by: string
          tires: Json | null
          updated_at: string
        }
        Insert: {
          car_id: string
          created_at?: string
          department_id: string
          id?: string
          kind: Database["public"]["Enums"]["car_care_kind"]
          note?: string | null
          reported_by: string
          tires?: Json | null
          updated_at?: string
        }
        Update: {
          car_id?: string
          created_at?: string
          department_id?: string
          id?: string
          kind?: Database["public"]["Enums"]["car_care_kind"]
          note?: string | null
          reported_by?: string
          tires?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "car_care_events_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_care_events_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_care_events_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      car_issues: {
        Row: {
          car_id: string
          category: Database["public"]["Enums"]["car_issue_category"] | null
          created_at: string
          department_id: string
          description: string
          id: string
          is_unsafe: boolean
          photo_path: string | null
          reported_by: string
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["car_issue_status"]
        }
        Insert: {
          car_id: string
          category?: Database["public"]["Enums"]["car_issue_category"] | null
          created_at?: string
          department_id: string
          description: string
          id?: string
          is_unsafe?: boolean
          photo_path?: string | null
          reported_by: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["car_issue_status"]
        }
        Update: {
          car_id?: string
          category?: Database["public"]["Enums"]["car_issue_category"] | null
          created_at?: string
          department_id?: string
          description?: string
          id?: string
          is_unsafe?: boolean
          photo_path?: string | null
          reported_by?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["car_issue_status"]
        }
        Relationships: [
          {
            foreignKeyName: "car_issues_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_issues_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_issues_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_issues_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      car_maintenance_blocks: {
        Row: {
          car_id: string
          created_at: string
          created_by: string
          department_id: string
          ends_at: string
          id: string
          reason: string
          starts_at: string
        }
        Insert: {
          car_id: string
          created_at?: string
          created_by: string
          department_id: string
          ends_at: string
          id?: string
          reason: string
          starts_at: string
        }
        Update: {
          car_id?: string
          created_at?: string
          created_by?: string
          department_id?: string
          ends_at?: string
          id?: string
          reason?: string
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "car_maintenance_blocks_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_maintenance_blocks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "car_maintenance_blocks_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      car_seat_configs: {
        Row: {
          adults: number
          boosters: number
          car_id: string
          child_seats: number
          id: string
        }
        Insert: {
          adults: number
          boosters?: number
          car_id: string
          child_seats?: number
          id?: string
        }
        Update: {
          adults?: number
          boosters?: number
          car_id?: string
          child_seats?: number
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "car_seat_configs_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
        ]
      }
      cars: {
        Row: {
          access_code: string | null
          built_in_boosters: number
          built_in_child_seats: number
          created_at: string
          department_id: string
          features: string[]
          id: string
          is_replaced: boolean
          license_plate: string
          name: string
          notes: string | null
          owner_id: string | null
          replacement_code: string | null
          responsible_id: string | null
          retired_at: string | null
          status: Database["public"]["Enums"]["car_status"]
          type: Database["public"]["Enums"]["car_type"]
          updated_at: string
        }
        Insert: {
          access_code?: string | null
          built_in_boosters?: number
          built_in_child_seats?: number
          created_at?: string
          department_id: string
          features?: string[]
          id?: string
          is_replaced?: boolean
          license_plate: string
          name: string
          notes?: string | null
          owner_id?: string | null
          replacement_code?: string | null
          responsible_id?: string | null
          retired_at?: string | null
          status?: Database["public"]["Enums"]["car_status"]
          type?: Database["public"]["Enums"]["car_type"]
          updated_at?: string
        }
        Update: {
          access_code?: string | null
          built_in_boosters?: number
          built_in_child_seats?: number
          created_at?: string
          department_id?: string
          features?: string[]
          id?: string
          is_replaced?: boolean
          license_plate?: string
          name?: string
          notes?: string | null
          owner_id?: string | null
          replacement_code?: string | null
          responsible_id?: string | null
          retired_at?: string | null
          status?: Database["public"]["Enums"]["car_status"]
          type?: Database["public"]["Enums"]["car_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cars_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cars_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cars_responsible_id_fkey"
            columns: ["responsible_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      child_guardians: {
        Row: {
          child_id: string
          profile_id: string
        }
        Insert: {
          child_id: string
          profile_id: string
        }
        Update: {
          child_id?: string
          profile_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "child_guardians_child_id_fkey"
            columns: ["child_id"]
            isOneToOne: false
            referencedRelation: "children"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "child_guardians_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      children: {
        Row: {
          birth_year: number | null
          created_at: string
          department_id: string
          full_name: string
          id: string
        }
        Insert: {
          birth_year?: number | null
          created_at?: string
          department_id: string
          full_name: string
          id?: string
        }
        Update: {
          birth_year?: number | null
          created_at?: string
          department_id?: string
          full_name?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "children_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      client_errors: {
        Row: {
          app_version: string | null
          created_at: string
          id: number
          message: string
          profile_id: string | null
          stack: string | null
          url: string | null
          user_agent: string | null
        }
        Insert: {
          app_version?: string | null
          created_at?: string
          id?: never
          message: string
          profile_id?: string | null
          stack?: string | null
          url?: string | null
          user_agent?: string | null
        }
        Update: {
          app_version?: string | null
          created_at?: string
          id?: never
          message?: string
          profile_id?: string | null
          stack?: string | null
          url?: string | null
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_errors_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      department_members: {
        Row: {
          added_by: string | null
          created_at: string
          department_id: string
          profile_id: string
          removed_at: string | null
          role: Database["public"]["Enums"]["role"]
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          department_id: string
          profile_id: string
          removed_at?: string | null
          role?: Database["public"]["Enums"]["role"]
        }
        Update: {
          added_by?: string | null
          created_at?: string
          department_id?: string
          profile_id?: string
          removed_at?: string | null
          role?: Database["public"]["Enums"]["role"]
        }
        Relationships: [
          {
            foreignKeyName: "department_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_members_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      department_settings: {
        Row: {
          auto_apply_accepted_proposals: boolean
          board_start_time: string
          chauffeur_dwell_minutes: number
          close_dow: number
          close_time: string
          closing_reminder_hours: number[]
          day_end_time: string
          department_id: string
          detour_limit_km: number
          detour_limit_minutes: number
          open_dow: number
          open_time: string
          overrides: Json
          proposal_expiry_hours: number
          proposal_expiry_mode: string
          publish_dow: number
          publish_time: string
          turnaround_minutes: number
          updated_at: string | null
          updated_by: string | null
          weeks_open_ahead: number
        }
        Insert: {
          auto_apply_accepted_proposals?: boolean
          board_start_time?: string
          chauffeur_dwell_minutes?: number
          close_dow?: number
          close_time?: string
          closing_reminder_hours?: number[]
          day_end_time?: string
          department_id: string
          detour_limit_km?: number
          detour_limit_minutes?: number
          open_dow?: number
          open_time?: string
          overrides?: Json
          proposal_expiry_hours?: number
          proposal_expiry_mode?: string
          publish_dow?: number
          publish_time?: string
          turnaround_minutes?: number
          updated_at?: string | null
          updated_by?: string | null
          weeks_open_ahead?: number
        }
        Update: {
          auto_apply_accepted_proposals?: boolean
          board_start_time?: string
          chauffeur_dwell_minutes?: number
          close_dow?: number
          close_time?: string
          closing_reminder_hours?: number[]
          day_end_time?: string
          department_id?: string
          detour_limit_km?: number
          detour_limit_minutes?: number
          open_dow?: number
          open_time?: string
          overrides?: Json
          proposal_expiry_hours?: number
          proposal_expiry_mode?: string
          publish_dow?: number
          publish_time?: string
          turnaround_minutes?: number
          updated_at?: string | null
          updated_by?: string | null
          weeks_open_ahead?: number
        }
        Relationships: [
          {
            foreignKeyName: "department_settings_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: true
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "department_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      departments: {
        Row: {
          created_at: string
          home_destination_id: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          home_destination_id?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          home_destination_id?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_home_destination_fk"
            columns: ["id", "home_destination_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
        ]
      }
      destinations: {
        Row: {
          aliases: string[]
          created_at: string
          created_by: string | null
          department_id: string
          distance_km: number | null
          id: string
          is_approved: boolean
          lat: number | null
          lng: number | null
          name: string
          public_transport_score: number | null
          travel_minutes: number | null
          updated_at: string
          zone: string
        }
        Insert: {
          aliases?: string[]
          created_at?: string
          created_by?: string | null
          department_id: string
          distance_km?: number | null
          id?: string
          is_approved?: boolean
          lat?: number | null
          lng?: number | null
          name: string
          public_transport_score?: number | null
          travel_minutes?: number | null
          updated_at?: string
          zone?: string
        }
        Update: {
          aliases?: string[]
          created_at?: string
          created_by?: string | null
          department_id?: string
          distance_km?: number | null
          id?: string
          is_approved?: boolean
          lat?: number | null
          lng?: number | null
          name?: string
          public_transport_score?: number | null
          travel_minutes?: number | null
          updated_at?: string
          zone?: string
        }
        Relationships: [
          {
            foreignKeyName: "destinations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "destinations_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      freed_slot_claims: {
        Row: {
          claimed_at: string | null
          decided_at: string | null
          decided_by: string | null
          id: string
          offer_id: string
          offered_at: string | null
          profile_id: string
          request_id: string
          status: Database["public"]["Enums"]["freed_claim_status"]
        }
        Insert: {
          claimed_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          offer_id: string
          offered_at?: string | null
          profile_id: string
          request_id: string
          status?: Database["public"]["Enums"]["freed_claim_status"]
        }
        Update: {
          claimed_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          offer_id?: string
          offered_at?: string | null
          profile_id?: string
          request_id?: string
          status?: Database["public"]["Enums"]["freed_claim_status"]
        }
        Relationships: [
          {
            foreignKeyName: "freed_slot_claims_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_claims_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "freed_slot_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_claims_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_claims_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_claims_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
        ]
      }
      freed_slot_offers: {
        Row: {
          cancelled_ride_id: string
          car_id: string
          created_at: string
          department_id: string
          ends_at: string
          expires_at: string
          id: string
          resolved_at: string | null
          resolved_by: string | null
          starts_at: string
          status: Database["public"]["Enums"]["freed_offer_status"]
          week_start: string
          winning_request_id: string | null
        }
        Insert: {
          cancelled_ride_id: string
          car_id: string
          created_at?: string
          department_id: string
          ends_at: string
          expires_at: string
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          starts_at: string
          status?: Database["public"]["Enums"]["freed_offer_status"]
          week_start: string
          winning_request_id?: string | null
        }
        Update: {
          cancelled_ride_id?: string
          car_id?: string
          created_at?: string
          department_id?: string
          ends_at?: string
          expires_at?: string
          id?: string
          resolved_at?: string | null
          resolved_by?: string | null
          starts_at?: string
          status?: Database["public"]["Enums"]["freed_offer_status"]
          week_start?: string
          winning_request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "freed_slot_offers_cancelled_ride_id_fkey"
            columns: ["cancelled_ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_offers_cancelled_ride_id_fkey"
            columns: ["cancelled_ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_offers_cancelled_ride_id_fkey"
            columns: ["cancelled_ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "freed_slot_offers_cancelled_ride_id_fkey"
            columns: ["cancelled_ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
          {
            foreignKeyName: "freed_slot_offers_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_offers_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_offers_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
          {
            foreignKeyName: "freed_slot_offers_winning_request_id_fkey"
            columns: ["winning_request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freed_slot_offers_winning_request_id_fkey"
            columns: ["winning_request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
        ]
      }
      member_invites: {
        Row: {
          consumed_at: string | null
          created_at: string
          department_id: string
          email: string
          full_name: string | null
          id: string
          invited_by: string | null
          phone: string | null
          role: Database["public"]["Enums"]["role"]
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          department_id: string
          email: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          phone?: string | null
          role?: Database["public"]["Enums"]["role"]
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          department_id?: string
          email?: string
          full_name?: string | null
          id?: string
          invited_by?: string | null
          phone?: string | null
          role?: Database["public"]["Enums"]["role"]
        }
        Relationships: [
          {
            foreignKeyName: "member_invites_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_templates: {
        Row: {
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          default_body: string | null
          default_title: string | null
          event: Database["public"]["Enums"]["notification_event"]
          id: string
          title: string | null
          updated_at: string | null
          updated_by: string | null
          variant: string | null
        }
        Insert: {
          body: string
          channel: Database["public"]["Enums"]["notification_channel"]
          default_body?: string | null
          default_title?: string | null
          event: Database["public"]["Enums"]["notification_event"]
          id?: string
          title?: string | null
          updated_at?: string | null
          updated_by?: string | null
          variant?: string | null
        }
        Update: {
          body?: string
          channel?: Database["public"]["Enums"]["notification_channel"]
          default_body?: string | null
          default_title?: string | null
          event?: Database["public"]["Enums"]["notification_event"]
          id?: string
          title?: string | null
          updated_at?: string | null
          updated_by?: string | null
          variant?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_templates_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body_he: string
          created_at: string
          data: Json
          dedupe_key: string | null
          department_id: string | null
          event: Database["public"]["Enums"]["notification_event"]
          id: string
          read_at: string | null
          recipient_id: string
          title_he: string
          week_start: string | null
        }
        Insert: {
          body_he: string
          created_at?: string
          data?: Json
          dedupe_key?: string | null
          department_id?: string | null
          event: Database["public"]["Enums"]["notification_event"]
          id?: string
          read_at?: string | null
          recipient_id: string
          title_he: string
          week_start?: string | null
        }
        Update: {
          body_he?: string
          created_at?: string
          data?: Json
          dedupe_key?: string | null
          department_id?: string | null
          event?: Database["public"]["Enums"]["notification_event"]
          id?: string
          read_at?: string | null
          recipient_id?: string
          title_he?: string
          week_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      policies: {
        Row: {
          created_at: string
          created_by: string | null
          current_version_id: string | null
          department_id: string
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          department_id: string
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          current_version_id?: string | null
          department_id?: string
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "policies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policies_current_version_fk"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "policy_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policies_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      policy_versions: {
        Row: {
          created_at: string
          created_by: string
          id: string
          note: string | null
          policy_id: string
          rules: Json
          version_no: number
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          note?: string | null
          policy_id: string
          rules: Json
          version_no: number
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          note?: string | null
          policy_id?: string
          rules?: Json
          version_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "policy_versions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "policy_versions_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "policies"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          approval_status: Database["public"]["Enums"]["approval_status"]
          approved_at: string | null
          approved_by: string | null
          avatar_url: string | null
          created_at: string
          default_boosters: number
          default_child_seats: number
          default_department_id: string | null
          display_name: string | null
          email: string
          full_name: string
          google_name: string
          home_week_preference: Database["public"]["Enums"]["home_week_preference"]
          id: string
          is_admin: boolean
          muted_events: Database["public"]["Enums"]["notification_event"][]
          phone: string | null
          updated_at: string
        }
        Insert: {
          approval_status?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          default_boosters?: number
          default_child_seats?: number
          default_department_id?: string | null
          display_name?: string | null
          email: string
          full_name?: string
          google_name?: string
          home_week_preference?: Database["public"]["Enums"]["home_week_preference"]
          id: string
          is_admin?: boolean
          muted_events?: Database["public"]["Enums"]["notification_event"][]
          phone?: string | null
          updated_at?: string
        }
        Update: {
          approval_status?: Database["public"]["Enums"]["approval_status"]
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          default_boosters?: number
          default_child_seats?: number
          default_department_id?: string | null
          display_name?: string | null
          email?: string
          full_name?: string
          google_name?: string
          home_week_preference?: Database["public"]["Enums"]["home_week_preference"]
          id?: string
          is_admin?: boolean
          muted_events?: Database["public"]["Enums"]["notification_event"][]
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_default_department_id_fkey"
            columns: ["default_department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_parties: {
        Row: {
          id: string
          profile_id: string
          proposal_id: string
          request_id: string | null
          responded_at: string | null
          responded_by: string | null
          responded_via: Database["public"]["Enums"]["answer_channel"] | null
          response: Database["public"]["Enums"]["party_response"]
          token_hash: string
        }
        Insert: {
          id?: string
          profile_id: string
          proposal_id: string
          request_id?: string | null
          responded_at?: string | null
          responded_by?: string | null
          responded_via?: Database["public"]["Enums"]["answer_channel"] | null
          response?: Database["public"]["Enums"]["party_response"]
          token_hash: string
        }
        Update: {
          id?: string
          profile_id?: string
          proposal_id?: string
          request_id?: string | null
          responded_at?: string | null
          responded_by?: string | null
          responded_via?: Database["public"]["Enums"]["answer_channel"] | null
          response?: Database["public"]["Enums"]["party_response"]
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposal_parties_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_parties_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_parties_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["pending_proposal_id"]
          },
          {
            foreignKeyName: "proposal_parties_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_parties_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
          {
            foreignKeyName: "proposal_parties_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          answer_note: string | null
          answered_at: string | null
          answered_by: string | null
          answered_via: Database["public"]["Enums"]["answer_channel"] | null
          applied_at: string | null
          applied_ride_id: string | null
          created_at: string
          created_by: string
          created_via: string
          department_id: string
          expires_at: string | null
          id: string
          payload: Json
          previous_status: Database["public"]["Enums"]["request_status"]
          reason_he: string
          request_id: string
          ride_id: string | null
          sent_at: string | null
          sent_via: Database["public"]["Enums"]["notification_channel"][]
          status: Database["public"]["Enums"]["proposal_status"]
          token_hash: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at: string
          version: number
          week_start: string
        }
        Insert: {
          answer_note?: string | null
          answered_at?: string | null
          answered_by?: string | null
          answered_via?: Database["public"]["Enums"]["answer_channel"] | null
          applied_at?: string | null
          applied_ride_id?: string | null
          created_at?: string
          created_by: string
          created_via?: string
          department_id: string
          expires_at?: string | null
          id?: string
          payload: Json
          previous_status: Database["public"]["Enums"]["request_status"]
          reason_he: string
          request_id: string
          ride_id?: string | null
          sent_at?: string | null
          sent_via?: Database["public"]["Enums"]["notification_channel"][]
          status?: Database["public"]["Enums"]["proposal_status"]
          token_hash: string
          type: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
          version?: number
          week_start: string
        }
        Update: {
          answer_note?: string | null
          answered_at?: string | null
          answered_by?: string | null
          answered_via?: Database["public"]["Enums"]["answer_channel"] | null
          applied_at?: string | null
          applied_ride_id?: string | null
          created_at?: string
          created_by?: string
          created_via?: string
          department_id?: string
          expires_at?: string | null
          id?: string
          payload?: Json
          previous_status?: Database["public"]["Enums"]["request_status"]
          reason_he?: string
          request_id?: string
          ride_id?: string | null
          sent_at?: string | null
          sent_via?: Database["public"]["Enums"]["notification_channel"][]
          status?: Database["public"]["Enums"]["proposal_status"]
          token_hash?: string
          type?: Database["public"]["Enums"]["proposal_type"]
          updated_at?: string
          version?: number
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposals_answered_by_fkey"
            columns: ["answered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_applied_ride_id_fkey"
            columns: ["applied_ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_applied_ride_id_fkey"
            columns: ["applied_ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_applied_ride_id_fkey"
            columns: ["applied_ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "proposals_applied_ride_id_fkey"
            columns: ["applied_ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
          {
            foreignKeyName: "proposals_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
          {
            foreignKeyName: "proposals_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "proposals_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
          {
            foreignKeyName: "proposals_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      push_outbox: {
        Row: {
          attempts: number
          created_at: string
          id: number
          last_error: string | null
          next_attempt_at: string
          notification_id: string
          payload: Json
          sent_at: string | null
          status: Database["public"]["Enums"]["push_outbox_status"]
          subscription_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: never
          last_error?: string | null
          next_attempt_at?: string
          notification_id: string
          payload: Json
          sent_at?: string | null
          status?: Database["public"]["Enums"]["push_outbox_status"]
          subscription_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: never
          last_error?: string | null
          next_attempt_at?: string
          notification_id?: string
          payload?: Json
          sent_at?: string | null
          status?: Database["public"]["Enums"]["push_outbox_status"]
          subscription_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_outbox_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_outbox_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "push_subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          failure_count: number
          id: string
          last_used_at: string | null
          p256dh: string
          profile_id: string
          user_agent: string | null
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          failure_count?: number
          id?: string
          last_used_at?: string | null
          p256dh: string
          profile_id: string
          user_agent?: string | null
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          failure_count?: number
          id?: string
          last_used_at?: string | null
          p256dh?: string
          profile_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      request_children: {
        Row: {
          child_id: string
          request_id: string
        }
        Insert: {
          child_id: string
          request_id: string
        }
        Update: {
          child_id?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "request_children_child_id_fkey"
            columns: ["child_id"]
            isOneToOne: false
            referencedRelation: "children"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_children_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_children_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
        ]
      }
      request_companions: {
        Row: {
          profile_id: string
          request_id: string
        }
        Insert: {
          profile_id: string
          request_id: string
        }
        Update: {
          profile_id?: string
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "request_companions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_companions_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_companions_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
        ]
      }
      request_templates: {
        Row: {
          adults: number
          boosters: number
          child_seats: number
          companion_ids: string[]
          created_at: string
          depart_dow: number | null
          depart_time: string | null
          department_id: string
          destination_id: string | null
          destination_text: string | null
          flex_depart_early: string
          flex_depart_late: string
          flex_return_early: string
          flex_return_late: string
          guest_passenger_names: string[]
          has_luggage: boolean
          id: string
          is_active: boolean
          last_materialized_week: string | null
          needs_car_at_destination: boolean
          notes: string | null
          one_way_car_mode: Database["public"]["Enums"]["leg_car_mode"] | null
          paused_until: string | null
          preferred_car_id: string | null
          requester_id: string
          return_dow: number | null
          return_time: string | null
          ride_description: string | null
          ride_type_id: string
          trip_shape: Database["public"]["Enums"]["trip_shape"]
          updated_at: string
        }
        Insert: {
          adults?: number
          boosters?: number
          child_seats?: number
          companion_ids?: string[]
          created_at?: string
          depart_dow?: number | null
          depart_time?: string | null
          department_id: string
          destination_id?: string | null
          destination_text?: string | null
          flex_depart_early?: string
          flex_depart_late?: string
          flex_return_early?: string
          flex_return_late?: string
          guest_passenger_names?: string[]
          has_luggage?: boolean
          id?: string
          is_active?: boolean
          last_materialized_week?: string | null
          needs_car_at_destination?: boolean
          notes?: string | null
          one_way_car_mode?: Database["public"]["Enums"]["leg_car_mode"] | null
          paused_until?: string | null
          preferred_car_id?: string | null
          requester_id: string
          return_dow?: number | null
          return_time?: string | null
          ride_description?: string | null
          ride_type_id: string
          trip_shape?: Database["public"]["Enums"]["trip_shape"]
          updated_at?: string
        }
        Update: {
          adults?: number
          boosters?: number
          child_seats?: number
          companion_ids?: string[]
          created_at?: string
          depart_dow?: number | null
          depart_time?: string | null
          department_id?: string
          destination_id?: string | null
          destination_text?: string | null
          flex_depart_early?: string
          flex_depart_late?: string
          flex_return_early?: string
          flex_return_late?: string
          guest_passenger_names?: string[]
          has_luggage?: boolean
          id?: string
          is_active?: boolean
          last_materialized_week?: string | null
          needs_car_at_destination?: boolean
          notes?: string | null
          one_way_car_mode?: Database["public"]["Enums"]["leg_car_mode"] | null
          paused_until?: string | null
          preferred_car_id?: string | null
          requester_id?: string
          return_dow?: number | null
          return_time?: string | null
          ride_description?: string | null
          ride_type_id?: string
          trip_shape?: Database["public"]["Enums"]["trip_shape"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "request_templates_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_templates_destination_id_fkey"
            columns: ["department_id", "destination_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "request_templates_preferred_car_id_fkey"
            columns: ["preferred_car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_templates_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_templates_ride_type_id_fkey"
            columns: ["department_id", "ride_type_id"]
            isOneToOne: false
            referencedRelation: "ride_types"
            referencedColumns: ["department_id", "id"]
          },
        ]
      }
      requests: {
        Row: {
          adults: number
          boosters: number
          changed_since_solve: boolean
          child_seats: number
          created_at: string
          depart_at: string | null
          department_id: string
          destination_id: string | null
          destination_text: string | null
          filed_by: string
          flex_depart_early: string
          flex_depart_late: string
          flex_return_early: string
          flex_return_late: string
          freed_slot_opt_out: boolean
          guest_passenger_names: string[]
          has_luggage: boolean
          id: string
          is_late: boolean
          join_ride_id: string | null
          manual_boost: number
          manual_boost_reason: string | null
          needs_car_at_destination: boolean
          notes: string | null
          one_way_car_mode: Database["public"]["Enums"]["leg_car_mode"] | null
          original_depart_at: string | null
          original_return_at: string | null
          preferred_car_id: string | null
          requester_id: string
          return_at: string | null
          ride_description: string | null
          ride_type_id: string
          status: Database["public"]["Enums"]["request_status"]
          status_reason: string | null
          submitted_at: string | null
          template_id: string | null
          trip_shape: Database["public"]["Enums"]["trip_shape"]
          updated_at: string
          version: number
          week_start: string
        }
        Insert: {
          adults?: number
          boosters?: number
          changed_since_solve?: boolean
          child_seats?: number
          created_at?: string
          depart_at?: string | null
          department_id: string
          destination_id?: string | null
          destination_text?: string | null
          filed_by: string
          flex_depart_early?: string
          flex_depart_late?: string
          flex_return_early?: string
          flex_return_late?: string
          freed_slot_opt_out?: boolean
          guest_passenger_names?: string[]
          has_luggage?: boolean
          id?: string
          is_late?: boolean
          join_ride_id?: string | null
          manual_boost?: number
          manual_boost_reason?: string | null
          needs_car_at_destination?: boolean
          notes?: string | null
          one_way_car_mode?: Database["public"]["Enums"]["leg_car_mode"] | null
          original_depart_at?: string | null
          original_return_at?: string | null
          preferred_car_id?: string | null
          requester_id: string
          return_at?: string | null
          ride_description?: string | null
          ride_type_id: string
          status?: Database["public"]["Enums"]["request_status"]
          status_reason?: string | null
          submitted_at?: string | null
          template_id?: string | null
          trip_shape?: Database["public"]["Enums"]["trip_shape"]
          updated_at?: string
          version?: number
          week_start: string
        }
        Update: {
          adults?: number
          boosters?: number
          changed_since_solve?: boolean
          child_seats?: number
          created_at?: string
          depart_at?: string | null
          department_id?: string
          destination_id?: string | null
          destination_text?: string | null
          filed_by?: string
          flex_depart_early?: string
          flex_depart_late?: string
          flex_return_early?: string
          flex_return_late?: string
          freed_slot_opt_out?: boolean
          guest_passenger_names?: string[]
          has_luggage?: boolean
          id?: string
          is_late?: boolean
          join_ride_id?: string | null
          manual_boost?: number
          manual_boost_reason?: string | null
          needs_car_at_destination?: boolean
          notes?: string | null
          one_way_car_mode?: Database["public"]["Enums"]["leg_car_mode"] | null
          original_depart_at?: string | null
          original_return_at?: string | null
          preferred_car_id?: string | null
          requester_id?: string
          return_at?: string | null
          ride_description?: string | null
          ride_type_id?: string
          status?: Database["public"]["Enums"]["request_status"]
          status_reason?: string | null
          submitted_at?: string | null
          template_id?: string | null
          trip_shape?: Database["public"]["Enums"]["trip_shape"]
          updated_at?: string
          version?: number
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "requests_destination_id_fkey"
            columns: ["department_id", "destination_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "requests_filed_by_fkey"
            columns: ["filed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_join_ride_fk"
            columns: ["join_ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_join_ride_fk"
            columns: ["join_ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_join_ride_fk"
            columns: ["join_ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "requests_join_ride_fk"
            columns: ["join_ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
          {
            foreignKeyName: "requests_preferred_car_id_fkey"
            columns: ["preferred_car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_ride_type_id_fkey"
            columns: ["department_id", "ride_type_id"]
            isOneToOne: false
            referencedRelation: "ride_types"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "requests_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "request_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      ride_change_parties: {
        Row: {
          accepted: boolean | null
          change_id: string
          created_at: string
          expected_version: number
          id: string
          profile_id: string
          responded_at: string | null
          ride_id: string
          updated_at: string
          version: number
        }
        Insert: {
          accepted?: boolean | null
          change_id: string
          created_at?: string
          expected_version: number
          id?: string
          profile_id: string
          responded_at?: string | null
          ride_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          accepted?: boolean | null
          change_id?: string
          created_at?: string
          expected_version?: number
          id?: string
          profile_id?: string
          responded_at?: string | null
          ride_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "ride_change_parties_change_id_fkey"
            columns: ["change_id"]
            isOneToOne: false
            referencedRelation: "ride_change_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_parties_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_parties_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_parties_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_parties_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "ride_change_parties_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
        ]
      }
      ride_change_requests: {
        Row: {
          car_id: string
          created_at: string
          department_id: string
          ends_at: string
          expected_version: number
          id: string
          is_planning: boolean
          requester_id: string
          ride_id: string
          starts_at: string
          status: string
          updated_at: string
          version: number
          week_start: string
        }
        Insert: {
          car_id: string
          created_at?: string
          department_id: string
          ends_at: string
          expected_version: number
          id?: string
          is_planning?: boolean
          requester_id: string
          ride_id: string
          starts_at: string
          status?: string
          updated_at?: string
          version?: number
          week_start: string
        }
        Update: {
          car_id?: string
          created_at?: string
          department_id?: string
          ends_at?: string
          expected_version?: number
          id?: string
          is_planning?: boolean
          requester_id?: string
          ride_id?: string
          starts_at?: string
          status?: string
          updated_at?: string
          version?: number
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "ride_change_requests_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_requests_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_requests_department_id_week_start_fkey"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
          {
            foreignKeyName: "ride_change_requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_change_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "ride_change_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
        ]
      }
      ride_requests: {
        Row: {
          car_mode: Database["public"]["Enums"]["leg_car_mode"]
          covers_out: boolean
          covers_return: boolean
          created_at: string
          detour_minutes: number
          leg: Database["public"]["Enums"]["ride_leg"]
          request_id: string
          ride_id: string
          role: Database["public"]["Enums"]["ride_role"]
        }
        Insert: {
          car_mode: Database["public"]["Enums"]["leg_car_mode"]
          covers_out?: boolean
          covers_return?: boolean
          created_at?: string
          detour_minutes?: number
          leg?: Database["public"]["Enums"]["ride_leg"]
          request_id: string
          ride_id: string
          role: Database["public"]["Enums"]["ride_role"]
        }
        Update: {
          car_mode?: Database["public"]["Enums"]["leg_car_mode"]
          covers_out?: boolean
          covers_return?: boolean
          created_at?: string
          detour_minutes?: number
          leg?: Database["public"]["Enums"]["ride_leg"]
          request_id?: string
          ride_id?: string
          role?: Database["public"]["Enums"]["ride_role"]
        }
        Relationships: [
          {
            foreignKeyName: "ride_requests_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_requests_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["request_id"]
          },
          {
            foreignKeyName: "ride_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_board_rides"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_car_locations"
            referencedColumns: ["leaving_ride_id"]
          },
          {
            foreignKeyName: "ride_requests_ride_id_fkey"
            columns: ["ride_id"]
            isOneToOne: false
            referencedRelation: "v_my_requests"
            referencedColumns: ["ride_id"]
          },
        ]
      }
      ride_types: {
        Row: {
          code: string
          department_id: string
          id: string
          is_active: boolean
          name_he: string
          sort_order: number
        }
        Insert: {
          code: string
          department_id: string
          id?: string
          is_active?: boolean
          name_he: string
          sort_order?: number
        }
        Update: {
          code?: string
          department_id?: string
          id?: string
          is_active?: boolean
          name_he?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "ride_types_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      rides: {
        Row: {
          blocked_until: string
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          car_id: string
          created_at: string
          created_by: string
          created_by_solver_run_id: string | null
          department_id: string
          destination_id: string
          driver_id: string | null
          ends_at: string
          flag_reason: string | null
          id: string
          is_pinned: boolean
          needs_driver: boolean
          notes: string | null
          origin_id: string
          overflow_allowed: boolean
          overnight_ack_at: string | null
          overnight_ack_by: string | null
          pin_reason: string | null
          planning_conflict: boolean
          starts_at: string
          status: Database["public"]["Enums"]["ride_status"]
          turnaround: string
          turnaround_override_minutes: number | null
          updated_at: string
          version: number
          week_start: string
        }
        Insert: {
          blocked_until: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          car_id: string
          created_at?: string
          created_by: string
          created_by_solver_run_id?: string | null
          department_id: string
          destination_id: string
          driver_id?: string | null
          ends_at: string
          flag_reason?: string | null
          id?: string
          is_pinned?: boolean
          needs_driver?: boolean
          notes?: string | null
          origin_id: string
          overflow_allowed?: boolean
          overnight_ack_at?: string | null
          overnight_ack_by?: string | null
          pin_reason?: string | null
          planning_conflict?: boolean
          starts_at: string
          status?: Database["public"]["Enums"]["ride_status"]
          turnaround?: string
          turnaround_override_minutes?: number | null
          updated_at?: string
          version?: number
          week_start: string
        }
        Update: {
          blocked_until?: string
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          car_id?: string
          created_at?: string
          created_by?: string
          created_by_solver_run_id?: string | null
          department_id?: string
          destination_id?: string
          driver_id?: string | null
          ends_at?: string
          flag_reason?: string | null
          id?: string
          is_pinned?: boolean
          needs_driver?: boolean
          notes?: string | null
          origin_id?: string
          overflow_allowed?: boolean
          overnight_ack_at?: string | null
          overnight_ack_by?: string | null
          pin_reason?: string | null
          planning_conflict?: boolean
          starts_at?: string
          status?: Database["public"]["Enums"]["ride_status"]
          turnaround?: string
          turnaround_override_minutes?: number | null
          updated_at?: string
          version?: number
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "rides_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_created_by_solver_run_id_fkey"
            columns: ["created_by_solver_run_id"]
            isOneToOne: false
            referencedRelation: "solver_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_destination_id_fkey"
            columns: ["department_id", "destination_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "rides_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_origin_id_fkey"
            columns: ["department_id", "origin_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "rides_overnight_ack_by_fkey"
            columns: ["overnight_ack_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      sadran_assignments: {
        Row: {
          assigned_by: string | null
          created_at: string
          department_id: string
          id: string
          profile_id: string
          week_start: string | null
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string
          department_id: string
          id?: string
          profile_id: string
          week_start?: string | null
        }
        Update: {
          assigned_by?: string | null
          created_at?: string
          department_id?: string
          id?: string
          profile_id?: string
          week_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sadran_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sadran_assignments_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sadran_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sadran_assignments_roster_fk"
            columns: ["department_id", "profile_id"]
            isOneToOne: false
            referencedRelation: "department_members"
            referencedColumns: ["department_id", "profile_id"]
          },
        ]
      }
      siddur_versions: {
        Row: {
          department_id: string
          diff_summary: Json
          id: string
          notified_count: number
          published_at: string
          published_by: string
          snapshot: Json
          version_no: number
          week_start: string
        }
        Insert: {
          department_id: string
          diff_summary?: Json
          id?: string
          notified_count?: number
          published_at?: string
          published_by: string
          snapshot: Json
          version_no: number
          week_start: string
        }
        Update: {
          department_id?: string
          diff_summary?: Json
          id?: string
          notified_count?: number
          published_at?: string
          published_by?: string
          snapshot?: Json
          version_no?: number
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "siddur_versions_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "siddur_versions_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      solver_runs: {
        Row: {
          applied: boolean
          department_id: string
          duration_ms: number
          error: string | null
          finished_at: string
          id: string
          input_hash: string
          policy_version_id: string
          ran_by: string
          solver_version: string
          started_at: string
          state_fingerprint: string | null
          status: Database["public"]["Enums"]["solver_run_status"]
          summary: Json
          week_start: string
        }
        Insert: {
          applied?: boolean
          department_id: string
          duration_ms: number
          error?: string | null
          finished_at: string
          id?: string
          input_hash: string
          policy_version_id: string
          ran_by: string
          solver_version: string
          started_at: string
          state_fingerprint?: string | null
          status: Database["public"]["Enums"]["solver_run_status"]
          summary?: Json
          week_start: string
        }
        Update: {
          applied?: boolean
          department_id?: string
          duration_ms?: number
          error?: string | null
          finished_at?: string
          id?: string
          input_hash?: string
          policy_version_id?: string
          ran_by?: string
          solver_version?: string
          started_at?: string
          state_fingerprint?: string | null
          status?: Database["public"]["Enums"]["solver_run_status"]
          summary?: Json
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "solver_runs_policy_version_id_fkey"
            columns: ["policy_version_id"]
            isOneToOne: false
            referencedRelation: "policy_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "solver_runs_ran_by_fkey"
            columns: ["ran_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "solver_runs_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      weeks: {
        Row: {
          close_at: string
          created_at: string
          department_id: string
          open_at: string
          opened_by: string | null
          phase: Database["public"]["Enums"]["week_phase"]
          publish_at: string
          publish_reminder_sent_at: string | null
          published_at: string | null
          published_days: string[]
          published_version_id: string | null
          settings_overrides: Json
          updated_at: string
          week_start: string
        }
        Insert: {
          close_at: string
          created_at?: string
          department_id: string
          open_at: string
          opened_by?: string | null
          phase?: Database["public"]["Enums"]["week_phase"]
          publish_at: string
          publish_reminder_sent_at?: string | null
          published_at?: string | null
          published_days?: string[]
          published_version_id?: string | null
          settings_overrides?: Json
          updated_at?: string
          week_start: string
        }
        Update: {
          close_at?: string
          created_at?: string
          department_id?: string
          open_at?: string
          opened_by?: string | null
          phase?: Database["public"]["Enums"]["week_phase"]
          publish_at?: string
          publish_reminder_sent_at?: string | null
          published_at?: string | null
          published_days?: string[]
          published_version_id?: string | null
          settings_overrides?: Json
          updated_at?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "weeks_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weeks_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weeks_published_version_fk"
            columns: ["published_version_id"]
            isOneToOne: false
            referencedRelation: "siddur_versions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_board_rides: {
        Row: {
          blocked_until: string | null
          car_id: string | null
          department_id: string | null
          destination_id: string | null
          destination_name: string | null
          driver_id: string | null
          driver_name: string | null
          ends_at: string | null
          id: string | null
          is_chauffeur: boolean | null
          is_pinned: boolean | null
          needs_driver: boolean | null
          notes: string | null
          origin_id: string | null
          origin_name: string | null
          overflow_allowed: boolean | null
          overnight_ack_by: string | null
          pin_reason: string | null
          planning_conflict: boolean | null
          served: Json | null
          starts_at: string | null
          status: Database["public"]["Enums"]["ride_status"] | null
          turnaround_override_minutes: number | null
          version: number | null
          week_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rides_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_destination_id_fkey"
            columns: ["department_id", "destination_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "rides_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_origin_id_fkey"
            columns: ["department_id", "origin_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "rides_overnight_ack_by_fkey"
            columns: ["overnight_ack_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      v_car_locations: {
        Row: {
          away_from: string | null
          away_until: string | null
          car_id: string | null
          department_id: string | null
          leaving_ride_id: string | null
          location_id: string | null
          location_name: string | null
          overnight_acknowledged: boolean | null
          week_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rides_car_id_fkey"
            columns: ["car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rides_destination_id_fkey"
            columns: ["department_id", "location_id"]
            isOneToOne: false
            referencedRelation: "destinations"
            referencedColumns: ["department_id", "id"]
          },
          {
            foreignKeyName: "rides_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      v_my_requests: {
        Row: {
          car_mode: Database["public"]["Enums"]["leg_car_mode"] | null
          car_name: string | null
          changed_since_solve: boolean | null
          child_names: string[] | null
          companions: Json | null
          depart_at: string | null
          department_id: string | null
          destination: string | null
          driver_name: string | null
          ends_at: string | null
          guest_passenger_names: string[] | null
          is_late: boolean | null
          leg: Database["public"]["Enums"]["ride_leg"] | null
          license_plate: string | null
          needs_car_at_destination: boolean | null
          needs_driver: boolean | null
          one_way_car_mode: Database["public"]["Enums"]["leg_car_mode"] | null
          original_depart_at: string | null
          original_return_at: string | null
          pending_proposal_expires_at: string | null
          pending_proposal_id: string | null
          pending_proposal_reason: string | null
          pending_proposal_type:
            | Database["public"]["Enums"]["proposal_type"]
            | null
          preferred_car_id: string | null
          request_id: string | null
          requester_id: string | null
          return_at: string | null
          ride_description: string | null
          ride_destination: string | null
          ride_id: string | null
          ride_origin: string | null
          ride_status: Database["public"]["Enums"]["ride_status"] | null
          ride_type_name: string | null
          role: Database["public"]["Enums"]["ride_role"] | null
          starts_at: string | null
          status: Database["public"]["Enums"]["request_status"] | null
          status_reason: string | null
          trip_shape: Database["public"]["Enums"]["trip_shape"] | null
          turnaround_override_minutes: number | null
          week_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "requests_preferred_car_id_fkey"
            columns: ["preferred_car_id"]
            isOneToOne: false
            referencedRelation: "cars"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_requester_id_fkey"
            columns: ["requester_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
      v_week_summary: {
        Row: {
          department_id: string | null
          request_count: number | null
          ride_type: string | null
          status: Database["public"]["Enums"]["request_status"] | null
          week_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "requests_week_fk"
            columns: ["department_id", "week_start"]
            isOneToOne: false
            referencedRelation: "weeks"
            referencedColumns: ["department_id", "week_start"]
          },
        ]
      }
    }
    Functions: {
      admin_approve_member: {
        Args: { p_department_id: string; p_profile_id: string }
        Returns: undefined
      }
      admin_set_sadran_assignments: {
        Args: {
          p_department_id: string
          p_profile_ids: string[]
          p_week_start?: string
        }
        Returns: undefined
      }
      admin_update_member: {
        Args: { p_details: Json; p_profile_id: string }
        Returns: undefined
      }
      advance_week_phases: { Args: { p_now?: string }; Returns: number }
      answer_proposal: {
        Args: {
          p_accept: boolean
          p_note?: string
          p_token: string
          p_via?: Database["public"]["Enums"]["answer_channel"]
        }
        Returns: Json
      }
      apply_proposal: { Args: { p_proposal_id: string }; Returns: string }
      apply_solver_result: {
        Args: { p_department_id: string; p_payload: Json; p_week_start: string }
        Returns: Json
      }
      approve_claim: {
        Args: { p_offer_id: string; p_request_id: string }
        Returns: string
      }
      assert_car_chain: {
        Args: { _car: string; _week: string }
        Returns: undefined
      }
      assert_named_passenger_counts: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      assert_publication_scores: {
        Args: { p_department_id: string; p_scores: Json; p_week_start: string }
        Returns: undefined
      }
      assert_ride_driver: { Args: { p_ride_id: string }; Returns: undefined }
      assert_ride_request_day: {
        Args: { p_ride_id: string }
        Returns: undefined
      }
      assert_ride_seats_fit: { Args: { v_ride: string }; Returns: undefined }
      assert_same_day_window: {
        Args: { p_end: string; p_start: string }
        Returns: undefined
      }
      can_manage_operations: {
        Args: { p_department_id?: string }
        Returns: boolean
      }
      can_manage_week: {
        Args: { _dept: string; _week: string }
        Returns: boolean
      }
      cancel_ride: {
        Args: {
          p_expected_version?: number
          p_reason: string
          p_ride_id: string
        }
        Returns: undefined
      }
      cancel_ride_change: { Args: { p_change_id: string }; Returns: undefined }
      cancel_ride_change_before_planning: {
        Args: { p_change_id: string }
        Returns: undefined
      }
      cancel_ride_without_passengers: {
        Args: {
          p_expected_version?: number
          p_reason: string
          p_ride_id: string
        }
        Returns: undefined
      }
      car_care_recipients: { Args: { _car_id: string }; Returns: string[] }
      car_fits: {
        Args: {
          _adults: number
          _boosters: number
          _car: string
          _child_seats: number
        }
        Returns: boolean
      }
      car_location_at: { Args: { _at: string; _car: string }; Returns: string }
      claim_freed_slot: {
        Args: { p_offer_id: string; p_request_id: string }
        Returns: undefined
      }
      claim_ride_driver: {
        Args: { p_expected_version: number; p_ride_id: string }
        Returns: undefined
      }
      close_offer: { Args: { p_offer_id: string }; Returns: undefined }
      create_department: {
        Args: {
          p_name: string
          p_slug: string
          p_source_department_id?: string
        }
        Returns: {
          created_at: string
          home_destination_id: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "departments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_policy_version: {
        Args: { p_note?: string; p_policy_id: string; p_rules: Json }
        Returns: string
      }
      create_proposal: {
        Args: {
          p_created_via?: string
          p_party_profile_ids?: string[]
          p_payload: Json
          p_reason_he: string
          p_request_id: string
          p_ride_id: string
          p_type: Database["public"]["Enums"]["proposal_type"]
        }
        Returns: string
      }
      crypt: { Args: { password: string; salt: string }; Returns: string }
      current_week_start: { Args: never; Returns: string }
      digest:
        | { Args: { data: string; type: string }; Returns: string }
        | { Args: { data: string; type: string }; Returns: string }
      dispatch_push_outbox_row: { Args: { _id: number }; Returns: undefined }
      drain_push_outbox: { Args: { _now?: string }; Returns: number }
      edit_ride: {
        Args: { p_expected_version?: number; p_ride: Json }
        Returns: string
      }
      edit_ride_before_planning: {
        Args: { p_expected_version?: number; p_ride: Json }
        Returns: string
      }
      enqueue_notification: {
        Args: {
          _data?: Json
          _dedupe_key?: string
          _department_id: string
          _event: Database["public"]["Enums"]["notification_event"]
          _recipient: string
          _vars?: Json
          _week_start: string
        }
        Returns: string
      }
      ensure_department_weeks: {
        Args: { p_department_id: string }
        Returns: undefined
      }
      enter_waiting_list: { Args: { p_payload: Json }; Returns: Json }
      expire_freed_offers: { Args: { _now?: string }; Returns: number }
      expire_proposals: { Args: { _now?: string }; Returns: number }
      fairness_stats: {
        Args: {
          p_department_id: string
          p_lookback_weeks: number
          p_week_start: string
        }
        Returns: {
          granted_hours: number
          profile_id: string
        }[]
      }
      freed_slot_candidates: {
        Args: { _offer: string }
        Returns: {
          fits: boolean
          request_id: string
          requester_id: string
          slack: string
        }[]
      }
      gen_random_bytes: { Args: { count: number }; Returns: string }
      gen_salt: { Args: { type: string }; Returns: string }
      generate_token: { Args: never; Returns: string }
      grant_admin: { Args: { p_profile_id: string }; Returns: undefined }
      housekeeping: { Args: { p_now?: string }; Returns: undefined }
      initialize_department_catalogs: {
        Args: { p_department_id: string; p_source_department_id: string }
        Returns: undefined
      }
      is_admin: { Args: never; Returns: boolean }
      is_approved: { Args: never; Returns: boolean }
      is_car_responsible: { Args: { _car_id: string }; Returns: boolean }
      is_day_public: {
        Args: { p_day: string; p_department_id: string; p_week_start: string }
        Returns: boolean
      }
      is_proposal_party: { Args: { _proposal_id: string }; Returns: boolean }
      is_quarter_hour: { Args: { _t: string }; Returns: boolean }
      is_request_companion: { Args: { _request_id: string }; Returns: boolean }
      is_sadran: { Args: { _dept: string; _week: string }; Returns: boolean }
      is_sadran_any: { Args: { _dept: string }; Returns: boolean }
      is_same_day_end: { Args: { p_end: string }; Returns: boolean }
      is_week_public: {
        Args: { _dept: string; _week: string }
        Returns: boolean
      }
      log_car_care: {
        Args: {
          _car_id: string
          _kind: Database["public"]["Enums"]["car_care_kind"]
          _note?: string
          _tires?: Json
        }
        Returns: string
      }
      materialize_department_weeks: {
        Args: { p_department_id: string; p_now: string }
        Returns: number
      }
      materialize_templates: { Args: never; Returns: number }
      maybe_apply_accepted_proposal: {
        Args: { p_proposal_id: string }
        Returns: undefined
      }
      member_of: { Args: { _dept: string }; Returns: boolean }
      merge_destination: {
        Args: { p_source_id: string; p_target_id: string }
        Returns: undefined
      }
      merge_request_fingerprint: {
        Args: { p_request_id: string }
        Returns: string
      }
      notification_context: {
        Args: {
          _data: Json
          _department_id: string
          _recipient: string
          _week_start: string
        }
        Returns: Json
      }
      notification_default_url: {
        Args: {
          _data: Json
          _department_id: string
          _event: Database["public"]["Enums"]["notification_event"]
          _week_start: string
        }
        Returns: string
      }
      open_week: {
        Args: { p_department_id: string; p_week_start: string }
        Returns: string
      }
      phone_of: { Args: { _profile: string }; Returns: string }
      prepare_manual_ride_window: {
        Args: {
          p_car_id: string
          p_ends_at: string
          p_ride_id?: string
          p_starts_at: string
          p_week_start: string
        }
        Returns: number
      }
      prepare_manual_ride_window_before_planning: {
        Args: {
          p_car_id: string
          p_ends_at: string
          p_ride_id?: string
          p_starts_at: string
          p_week_start: string
        }
        Returns: number
      }
      publication_conflicting_ride_ids: {
        Args: {
          p_days: string[]
          p_department_id: string
          p_week_start: string
        }
        Returns: string[]
      }
      publication_readiness: {
        Args: { p_department_id: string; p_week_start: string }
        Returns: Json
      }
      publish_scores_fingerprint: {
        Args: { p_department_id: string; p_week_start: string }
        Returns: string
      }
      publish_siddur: {
        Args: {
          p_allow_unanswered?: boolean
          p_days?: string[]
          p_department_id: string
          p_expected_fingerprint?: string
          p_policy_scores?: Json
          p_profile_scores?: Json
          p_week_start: string
        }
        Returns: string
      }
      raise_stale_version: { Args: never; Returns: undefined }
      record_answer_on_behalf: {
        Args: {
          p_accept: boolean
          p_note?: string
          p_profile_id: string
          p_proposal_id: string
        }
        Returns: undefined
      }
      record_solver_preview: {
        Args: { p_department_id: string; p_payload: Json; p_week_start: string }
        Returns: string
      }
      refresh_car_turnarounds: {
        Args: { p_car_id: string; p_week_start: string }
        Returns: undefined
      }
      register_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_p256dh: string
          p_user_agent?: string
        }
        Returns: string
      }
      release_request_draft_rides: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      render_notification_text: {
        Args: { _text: string; _vars: Json }
        Returns: string
      }
      reopen_week: {
        Args: {
          p_department_id: string
          p_expected_fingerprint: string
          p_phase: Database["public"]["Enums"]["week_phase"]
          p_week_start: string
        }
        Returns: undefined
      }
      report_car_issue: {
        Args: {
          _car_id: string
          _category: Database["public"]["Enums"]["car_issue_category"]
          _description: string
          _photo_path?: string
        }
        Returns: string
      }
      report_car_issue_unsafe_to_maintenance: {
        Args: { p_hours?: number; p_issue_id: string }
        Returns: string
      }
      request_ride_change: {
        Args: {
          p_car_id: string
          p_ends_at: string
          p_expected_version: number
          p_ride_id: string
          p_starts_at: string
        }
        Returns: string
      }
      request_served_by_public_ride: {
        Args: { _request_id: string }
        Returns: boolean
      }
      request_span: {
        Args: { _depart: string; _return: string }
        Returns: unknown
      }
      required_turnaround_minutes: {
        Args: { p_department_id: string; p_week_start: string }
        Returns: number
      }
      reserve_live_one_way_slot: {
        Args: { p_request_id: string }
        Returns: Json
      }
      resolve_freed_offer: {
        Args: { p_offer_id: string; p_ranked_candidates: Json }
        Returns: undefined
      }
      respond_ride_change: {
        Args: { p_accept: boolean; p_change_id: string }
        Returns: undefined
      }
      respond_ride_change_before_planning: {
        Args: { p_accept: boolean; p_change_id: string }
        Returns: undefined
      }
      sadran_contact_of: {
        Args: { _department_id: string; _week_start: string }
        Returns: {
          full_name: string
          person_id: string
          phone: string
        }[]
      }
      sadranim_of: { Args: { _dept: string; _week: string }; Returns: string[] }
      send_due_reminders: { Args: { p_now?: string }; Returns: number }
      send_proposal: {
        Args: {
          p_proposal_id: string
          p_replace_expected_version?: number
          p_replace_proposal_id?: string
          p_sent_via?: Database["public"]["Enums"]["notification_channel"][]
        }
        Returns: Json
      }
      set_freed_slot_opt_out: {
        Args: { p_opt_out: boolean; p_request_id: string }
        Returns: undefined
      }
      set_manual_boost: {
        Args: { p_reason: string; p_request_id: string; p_value: number }
        Returns: undefined
      }
      set_policy_active: {
        Args: { p_is_active: boolean; p_policy_id: string }
        Returns: undefined
      }
      set_request_children: {
        Args: { p_child_ids: string[]; p_request_id: string }
        Returns: undefined
      }
      set_week_phase: {
        Args: {
          p_department_id: string
          p_phase: Database["public"]["Enums"]["week_phase"]
          p_week_start: string
        }
        Returns: undefined
      }
      shares_ride_with: { Args: { _profile: string }; Returns: boolean }
      submit_request: { Args: { payload: Json }; Returns: Json }
      suggest_destination: {
        Args: { p_department_id: string; p_name: string; p_zone?: string }
        Returns: string
      }
      try_auto_approve: { Args: { p_request_id: string }; Returns: Json }
      unassign_ride: {
        Args: { p_expected_version: number; p_ride_id: string }
        Returns: undefined
      }
      update_ride_public_notes: {
        Args: { p_expected_version: number; p_notes: string; p_ride_id: string }
        Returns: undefined
      }
      validate_policy_rules: { Args: { _rules: Json }; Returns: boolean }
      validate_proposal_payload: {
        Args: {
          _payload: Json
          _type: Database["public"]["Enums"]["proposal_type"]
        }
        Returns: boolean
      }
      week_range: { Args: { _week_start: string }; Returns: unknown }
      week_state_fingerprint: {
        Args: { p_department_id: string; p_week_start: string }
        Returns: string
      }
      withdraw_all_requests: {
        Args: { p_department_id: string; p_week_start: string }
        Returns: number
      }
      withdraw_freed_slot_claim: {
        Args: { p_offer_id: string; p_request_id: string }
        Returns: undefined
      }
      withdraw_request: {
        Args: { p_expected_version: number; p_request_id: string }
        Returns: undefined
      }
    }
    Enums: {
      answer_channel: "token" | "session" | "sadran"
      approval_status: "pending" | "approved" | "blocked"
      audit_action: "insert" | "update" | "delete"
      car_care_kind: "tire_fill" | "wash"
      car_issue_category:
        | "warning_light"
        | "mechanical"
        | "lighting"
        | "physical_damage"
      car_issue_status: "open" | "resolved"
      car_status: "active" | "maintenance" | "retired"
      car_type: "shared" | "temporary"
      freed_claim_status:
        | "offered"
        | "claimed"
        | "approved"
        | "declined"
        | "withdrawn"
      freed_offer_status:
        | "open"
        | "auto_assigned"
        | "pending_approval"
        | "approved"
        | "expired"
        | "closed"
      home_week_preference: "auto" | "live" | "open"
      leg_car_mode: "keep" | "relay" | "passenger" | "chauffeur"
      notification_channel: "push" | "inbox" | "whatsapp" | "email"
      notification_event:
        | "window_open"
        | "window_closing"
        | "window_closed_solve_now"
        | "publish_reminder"
        | "published"
        | "outcome_changed"
        | "proposal_received"
        | "proposal_answered"
        | "freed_slot"
        | "freed_slot_auto"
        | "claim_approved"
        | "claim_declined"
        | "claim_contested"
        | "maintenance_affects"
        | "late_request"
        | "waitlisted_request"
        | "auto_approved"
        | "request_changed"
        | "access_request"
        | "access_approved"
        | "status_changed"
        | "car_care"
      party_response: "pending" | "accepted" | "declined"
      proposal_status:
        | "draft"
        | "sent"
        | "accepted"
        | "declined"
        | "expired"
        | "applied"
        | "withdrawn"
      proposal_type: "shift" | "merge" | "deny" | "external"
      push_outbox_status: "pending" | "sent" | "failed" | "dead"
      request_status:
        | "draft"
        | "submitted"
        | "proposed"
        | "assigned"
        | "merged"
        | "waitlisted"
        | "denied"
        | "external"
        | "withdrawn"
        | "cancelled"
      ride_leg: "out" | "return" | "both"
      ride_role: "driver" | "passenger"
      ride_status: "draft" | "confirmed" | "flagged" | "cancelled"
      role: "member" | "sadran" | "admin"
      solver_run_status: "succeeded" | "failed"
      tire_state: "ok" | "low" | "very_low"
      trip_shape: "round_trip" | "one_way_to" | "one_way_from"
      week_phase: "open" | "solving" | "published" | "live" | "archived"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      answer_channel: ["token", "session", "sadran"],
      approval_status: ["pending", "approved", "blocked"],
      audit_action: ["insert", "update", "delete"],
      car_care_kind: ["tire_fill", "wash"],
      car_issue_category: [
        "warning_light",
        "mechanical",
        "lighting",
        "physical_damage",
      ],
      car_issue_status: ["open", "resolved"],
      car_status: ["active", "maintenance", "retired"],
      car_type: ["shared", "temporary"],
      freed_claim_status: [
        "offered",
        "claimed",
        "approved",
        "declined",
        "withdrawn",
      ],
      freed_offer_status: [
        "open",
        "auto_assigned",
        "pending_approval",
        "approved",
        "expired",
        "closed",
      ],
      home_week_preference: ["auto", "live", "open"],
      leg_car_mode: ["keep", "relay", "passenger", "chauffeur"],
      notification_channel: ["push", "inbox", "whatsapp", "email"],
      notification_event: [
        "window_open",
        "window_closing",
        "window_closed_solve_now",
        "publish_reminder",
        "published",
        "outcome_changed",
        "proposal_received",
        "proposal_answered",
        "freed_slot",
        "freed_slot_auto",
        "claim_approved",
        "claim_declined",
        "claim_contested",
        "maintenance_affects",
        "late_request",
        "waitlisted_request",
        "auto_approved",
        "request_changed",
        "access_request",
        "access_approved",
        "status_changed",
        "car_care",
      ],
      party_response: ["pending", "accepted", "declined"],
      proposal_status: [
        "draft",
        "sent",
        "accepted",
        "declined",
        "expired",
        "applied",
        "withdrawn",
      ],
      proposal_type: ["shift", "merge", "deny", "external"],
      push_outbox_status: ["pending", "sent", "failed", "dead"],
      request_status: [
        "draft",
        "submitted",
        "proposed",
        "assigned",
        "merged",
        "waitlisted",
        "denied",
        "external",
        "withdrawn",
        "cancelled",
      ],
      ride_leg: ["out", "return", "both"],
      ride_role: ["driver", "passenger"],
      ride_status: ["draft", "confirmed", "flagged", "cancelled"],
      role: ["member", "sadran", "admin"],
      solver_run_status: ["succeeded", "failed"],
      tire_state: ["ok", "low", "very_low"],
      trip_shape: ["round_trip", "one_way_to", "one_way_from"],
      week_phase: ["open", "solving", "published", "live", "archived"],
    },
  },
} as const

