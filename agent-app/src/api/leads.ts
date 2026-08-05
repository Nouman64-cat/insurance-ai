import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type EntityType = 'INDIVIDUAL' | 'FAMILY' | 'CORPORATE';
export type ProfileStatus =
  | 'LEAD'
  | 'PROSPECT'
  | 'UNDERWRITING_READY'
  | 'NOT_INTERESTED'
  | 'POLICYHOLDER'
  | 'DRAFT';

/**
 * Which slice of the tenant's book to read.
 *  - `mine`: only leads assigned to the signed-in agent.
 *  - `all`:  every lead in the tenant — admins and underwriters only.
 */
export type LeadScope = 'mine' | 'all';

export interface UnifiedLead {
  id: string;
  type: EntityType;
  name: string;
  contact_info: string;
  created_at: string;
  status: ProfileStatus;
  primaryIdentifier?: string;
  displayId?: string;
  /** Who owns this lead. Null when nobody has been assigned yet. */
  assignedAgentId?: string | null;
  /** Resolved from the tenant user directory — the API returns only the id. */
  assignedAgentName?: string | null;
  city?: string | null;
  email?: string | null;
  /** Members for a family, employees for an organization. */
  memberCount?: number;
  /**
   * Roll-up policy status for family and corporate leads ("Active" | "Pending"),
   * computed by the list endpoints. Individual leads carry their policies
   * directly instead, so this stays undefined for them.
   */
  groupPolicyStatus?: string | null;
}

export interface Branch {
  id: string;
  name: string;
  branch_code: string;
}

export interface InsurancePlan {
  id: string;
  label: string;
  description: string;
}

export interface Agent {
  id: string;
  full_name: string;
  email: string;
}

const requireTenantId = async (): Promise<string> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('You are signed out. Please sign in again.');
  return tenantId;
};

const entityPath = (type: EntityType) =>
  type === 'INDIVIDUAL' ? 'customers' : type === 'FAMILY' ? 'families' : 'organizations';

/**
 * The list endpoints are partitioned by `category`, and a lead can sit in any
 * of them, so a full picture needs every bucket. One slow bucket must not blank
 * the whole board — `allSettled` lets the rest through and the caller shows
 * what it has.
 */
const settledData = (result: PromiseSettledResult<{ data: unknown }>): any[] => {
  if (result.status !== 'fulfilled') return [];
  return Array.isArray(result.value.data) ? result.value.data : [];
};

/** Caches the tenant's agent directory so a poll cycle doesn't refetch it. */
let agentDirectory: { tenantId: string; byId: Map<string, string> } | null = null;

const loadAgentDirectory = async (tenantId: string): Promise<Map<string, string>> => {
  if (agentDirectory?.tenantId === tenantId) return agentDirectory.byId;
  try {
    const res = await api.get(`/tenants/${tenantId}/users/directory`);
    const byId = new Map<string, string>(
      (res.data || []).map((u: any) => [String(u.id), u.full_name || u.email || 'Unknown'])
    );
    agentDirectory = { tenantId, byId };
    return byId;
  } catch {
    // Names are a nicety; the board must still render without them.
    return new Map();
  }
};

/** Drops the cache so a re-login or a newly created user is picked up. */
export const invalidateAgentDirectory = () => {
  agentDirectory = null;
};

export interface FetchLeadsOptions {
  /** Defaults to `mine`, the safe choice if a caller forgets to pass a scope. */
  scope?: LeadScope;
  /** Overrides the stored agent id — used when an admin filters by one agent. */
  agentId?: string;
}

export const fetchLeads = async (options: FetchLeadsOptions = {}): Promise<UnifiedLead[]> => {
  const { scope = 'mine' } = options;
  const tenantId = await requireTenantId();
  const storedAgentId = await AsyncStorage.getItem('agent_id');
  const agentId = options.agentId ?? storedAgentId ?? undefined;

  // `all` deliberately omits the filter so admins see the whole tenant.
  const scopeParams = scope === 'all' ? {} : { assigned_agent_id: agentId || undefined };

  const [directory, results] = await Promise.all([
    loadAgentDirectory(tenantId),
    Promise.allSettled([
      api.get(`/tenants/${tenantId}/customers`, { params: { category: 'full_details', ...scopeParams } }),
      api.get(`/tenants/${tenantId}/customers`, { params: { category: 'quick_lead', ...scopeParams } }),
      api.get(`/tenants/${tenantId}/customers`, { params: { category: 'not_interested', ...scopeParams } }),
      api.get(`/tenants/${tenantId}/families`, { params: { category: 'in_progress', ...scopeParams } }),
      api.get(`/tenants/${tenantId}/families`, { params: { category: 'new', ...scopeParams } }),
      api.get(`/tenants/${tenantId}/organizations`, { params: { category: 'in_progress', ...scopeParams } }),
      api.get(`/tenants/${tenantId}/organizations`, { params: { category: 'new', ...scopeParams } }),
    ]),
  ]);

  // Every bucket failing means the network or the token is gone, not that the
  // agent has no leads — surfacing an empty board there would be a lie.
  if (results.every((r) => r.status === 'rejected')) {
    const firstError = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    throw new Error(firstError?.reason?.message ?? 'Could not reach the server.');
  }

  const nameFor = (id?: string | null) => (id ? directory.get(String(id)) ?? null : null);

  // A lead can appear in more than one bucket; keyed by id so it lands once.
  const byId = new Map<string, UnifiedLead>();

  const addCustomers = (rows: any[]) => {
    rows.forEach((c) => {
      if (c.profile_status === 'POLICYHOLDER') return;
      byId.set(c.id, {
        id: c.id,
        type: 'INDIVIDUAL',
        name: c.name,
        contact_info: c.details?.contact?.mobile_number || c.details?.phone || 'No phone',
        created_at: c.created_at,
        status: c.profile_status || 'LEAD',
        primaryIdentifier: c.cnic,
        assignedAgentId: c.assigned_agent_id ?? null,
        assignedAgentName: nameFor(c.assigned_agent_id),
        city: c.city ?? null,
        email: c.details?.contact?.email ?? null,
      });
    });
  };

  const addFamilies = (rows: any[]) => {
    rows.forEach((f) => {
      if (f.profile_status === 'POLICYHOLDER') return;
      byId.set(f.id, {
        id: f.id,
        type: 'FAMILY',
        name: f.name,
        contact_info: f.contact_phone || f.contact_email || 'No contact',
        created_at: f.created_at,
        status: f.profile_status || 'LEAD',
        assignedAgentId: f.assigned_agent_id ?? null,
        assignedAgentName: nameFor(f.assigned_agent_id),
        city: f.city ?? null,
        email: f.contact_email ?? null,
        memberCount: f.member_count ?? 0,
        groupPolicyStatus: f.family_policy_status ?? null,
      });
    });
  };

  const addOrgs = (rows: any[]) => {
    rows.forEach((o) => {
      if (o.profile_status === 'POLICYHOLDER') return;
      byId.set(o.id, {
        id: o.id,
        type: 'CORPORATE',
        name: o.name,
        contact_info: o.contact_phone || o.contact_email || 'No contact',
        created_at: o.created_at,
        status: o.profile_status || 'LEAD',
        primaryIdentifier: o.registration_number,
        assignedAgentId: o.assigned_agent_id ?? null,
        assignedAgentName: nameFor(o.assigned_agent_id),
        city: o.city ?? null,
        email: o.contact_email ?? null,
        memberCount: o.employee_count ?? 0,
        groupPolicyStatus: o.master_policy_status ?? null,
      });
    });
  };

  addCustomers(settledData(results[0]));
  addCustomers(settledData(results[1]));
  addCustomers(settledData(results[2]));
  addFamilies(settledData(results[3]));
  addFamilies(settledData(results[4]));
  addOrgs(settledData(results[5]));
  addOrgs(settledData(results[6]));

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
};

/** @deprecated Use `fetchLeads({ scope })`, which respects the caller's role. */
export const fetchAgentLeads = (): Promise<UnifiedLead[]> => fetchLeads({ scope: 'mine' });

export const updateLeadStatus = async (lead: UnifiedLead, newStatus: ProfileStatus) => {
  const tenantId = await requireTenantId();
  const path = `/tenants/${tenantId}/${entityPath(lead.type)}/${lead.id}`;

  // Customers expose a full PUT; families and organizations only take PATCH.
  if (lead.type === 'INDIVIDUAL') {
    await api.put(path, { profile_status: newStatus });
  } else {
    await api.patch(path, { profile_status: newStatus });
  }
};

export const deleteLead = async (lead: UnifiedLead) => {
  const tenantId = await requireTenantId();
  await api.delete(`/tenants/${tenantId}/${entityPath(lead.type)}/${lead.id}`);
};

export const createIndividualLead = async (data: any) => {
  const tenantId = await requireTenantId();
  const agentId = await AsyncStorage.getItem('agent_id');

  if (data.leadCategory === 'quick') {
    return api.post(`/tenants/${tenantId}/customers`, {
      first_name: data.firstName,
      last_name: data.lastName,
      profile_status: 'LEAD',
      assigned_agent_id: data.assignedAgentId || agentId || null,
      details: {
        phone: data.phone,
        created_via: 'Agent App Quick Lead',
      },
    });
  }

  return api.post(`/tenants/${tenantId}/customers`, {
    cnic: data.cnic || null,
    first_name: data.firstName,
    last_name: data.lastName,
    dob: data.dob || null,
    gender: data.gender || 'Male',
    occupation: data.occupation || null,
    declared_income: data.declaredIncome ? parseFloat(data.declaredIncome) : null,
    city: data.city || null,
    province: data.province || null,
    assigned_agent_id: data.assignedAgentId || agentId || null,
    branch_id: data.branch || null,
    details: {
      marital_status: data.maritalStatus || 'Single',
      nationality: data.nationality || 'Pakistani',
      cnic_issue_date: data.cnicIssueDate || null,
      cnic_expiry_date: data.cnicExpiryDate || null,
      cnic_front_image: data.cnicFront || null,
      cnic_back_image: data.cnicBack || null,
      created_via: 'Agent App',
      address: {
        street: data.streetAddress || null,
        city: data.city || null,
        province: data.province || null,
        postal_code: data.postalCode || null,
      },
      contact: {
        mobile_number: data.phone,
        email: data.contactEmail || null,
        emergency_contact_name: data.emergencyContactName || null,
      },
      employment: {
        employer_name: data.employerName || null,
        industry_sector: data.industrySector || null,
        years_of_experience: data.yearsOfExperience ? parseInt(data.yearsOfExperience, 10) : null,
      },
      medical: {
        height_cm: data.height ? parseFloat(data.height) : null,
        weight_kg: data.weight ? parseFloat(data.weight) : null,
        exercise_frequency: data.exerciseFrequency || null,
      },
      habit_check: {
        smoking_status: data.smokingStatus || null,
        alcohol_consumption: data.alcoholConsumption || null,
        recreational_drug_use: data.recreationalDrugUse || false,
        participates_extreme_sports: data.participatesExtremeSports || false,
        extreme_sports_details: data.extremeSports || null,
        private_aviation: data.privateAviation || false,
        frequent_high_risk_travel: data.frequentHighRiskTravel || false,
        travel_destinations: data.travelDestinations || null,
        moving_violations: data.movingViolations ? parseInt(data.movingViolations, 10) : null,
      },
      financial: {
        credit_score: data.creditScore ? parseInt(data.creditScore, 10) : null,
      },
      nominee: {
        first_name: data.beneficiaryFirstName || null,
        last_name: data.beneficiaryLastName || null,
        cnic: data.beneficiaryCnic || null,
        relationship: data.beneficiaryRelationship || null,
        share_percentage: data.beneficiaryShare ? parseFloat(data.beneficiaryShare) : null,
      },
      insurance_plan_id: data.insurancePlanId || null,
    },
  });
};

export const createFamilyLead = async (data: any) => {
  const tenantId = await requireTenantId();
  const agentId = await AsyncStorage.getItem('agent_id');

  if (data.leadCategory === 'quick') {
    return api.post(`/tenants/${tenantId}/families`, {
      name: data.name,
      contact_person: data.contactPerson || null,
      contact_phone: data.contactPhone || null,
      // Without this the lead lands unassigned and never reaches the agent's
      // own board — the quick path used to drop it.
      assigned_agent_id: data.assignedAgentId || agentId || null,
    });
  }

  return api.post(`/tenants/${tenantId}/families`, {
    name: data.name,
    contact_person: data.contactPerson || null,
    contact_email: data.contactEmail || null,
    contact_phone: data.contactPhone || null,
    household_declared_income: data.householdIncome ? parseFloat(data.householdIncome) : null,
    city: data.city || null,
    province: data.province || null,
    assigned_agent_id: data.assignedAgentId || agentId || null,
    branch_id: data.branch || null,
  });
};

export const createCorporateLead = async (data: any) => {
  const tenantId = await requireTenantId();
  const agentId = await AsyncStorage.getItem('agent_id');

  if (data.leadCategory === 'quick') {
    return api.post(`/tenants/${tenantId}/organizations`, {
      name: data.name,
      contact_person: data.contactPerson || null,
      contact_phone: data.contactPhone || null,
      assigned_agent_id: data.assignedAgentId || agentId || null,
    });
  }

  return api.post(`/tenants/${tenantId}/organizations`, {
    name: data.name,
    registration_number: data.registrationNumber || null,
    industry: data.industry || null,
    contact_person: data.contactPerson || null,
    contact_email: data.contactEmail || null,
    contact_phone: data.contactPhone || null,
    city: data.city || null,
    province: data.province || null,
    assigned_agent_id: data.assignedAgentId || agentId || null,
    branch_id: data.branch || null,
  });
};

export const fetchBranches = async (): Promise<Branch[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) return [];
  try {
    const res = await api.get(`/tenants/${tenantId}/branches`);
    return res.data ?? [];
  } catch {
    return [];
  }
};

export const fetchAgents = async (): Promise<Agent[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) return [];
  try {
    const [rolesResp, usersResp] = await Promise.all([
      api.get('/roles'),
      api.get(`/tenants/${tenantId}/users/directory`),
    ]);
    const role = (rolesResp.data || []).find((r: any) => r.name === 'Agent');
    if (!role) return [];
    return (usersResp.data || [])
      .filter((u: any) => u.role_id === role.id)
      .map((u: any) => ({ id: u.id, full_name: u.full_name, email: u.email }));
  } catch {
    return [];
  }
};

export const fetchInsurancePlans = async (): Promise<InsurancePlan[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) return [];
  try {
    const res = await api.get(`/tenants/${tenantId}/insurance-plans`);
    return res.data ?? [];
  } catch {
    return [];
  }
};
