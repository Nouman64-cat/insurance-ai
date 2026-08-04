import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type EntityType = 'INDIVIDUAL' | 'FAMILY' | 'CORPORATE';
export type ProfileStatus = 'LEAD' | 'PROSPECT' | 'UNDERWRITING_READY' | 'NOT_INTERESTED' | 'POLICYHOLDER';

export interface UnifiedLead {
  id: string;
  type: EntityType;
  name: string;
  contact_info: string;
  created_at: string;
  status: ProfileStatus;
  primaryIdentifier?: string;
  displayId?: string;
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

export const fetchAgentLeads = async (): Promise<UnifiedLead[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');

  const params = { assigned_agent_id: agentId || undefined };

  const [
    custFullRes, custQuickRes, custNotIntRes,
    famInProgressRes, famNewRes,
    orgInProgressRes, orgNewRes
  ] = await Promise.all([
    api.get(`/tenants/${tenantId}/customers`, { params: { category: 'full_details', ...params } }),
    api.get(`/tenants/${tenantId}/customers`, { params: { category: 'quick_lead', ...params } }),
    api.get(`/tenants/${tenantId}/customers`, { params: { category: 'not_interested', ...params } }),
    api.get(`/tenants/${tenantId}/families`, { params: { category: 'in_progress', ...params } }),
    api.get(`/tenants/${tenantId}/families`, { params: { category: 'new', ...params } }),
    api.get(`/tenants/${tenantId}/organizations`, { params: { category: 'in_progress', ...params } }),
    api.get(`/tenants/${tenantId}/organizations`, { params: { category: 'new', ...params } })
  ]);

  const unified: UnifiedLead[] = [];

  const addCustomers = (data: any[]) => {
    data?.forEach(c => {
      if (c.profile_status !== 'POLICYHOLDER') {
        unified.push({
          id: c.id, type: 'INDIVIDUAL', name: c.name,
          contact_info: c.details?.phone || 'No phone',
          created_at: c.created_at, status: c.profile_status || 'LEAD',
          primaryIdentifier: c.cnic,
        });
      }
    });
  };

  const addFamilies = (data: any[]) => {
    data?.forEach(f => {
      if (f.profile_status !== 'POLICYHOLDER') {
        unified.push({
          id: f.id, type: 'FAMILY', name: f.name,
          contact_info: f.contact_phone || f.contact_email || 'No contact',
          created_at: f.created_at, status: f.profile_status || 'LEAD',
        });
      }
    });
  };

  const addOrgs = (data: any[]) => {
    data?.forEach(o => {
      if (o.profile_status !== 'POLICYHOLDER') {
        unified.push({
          id: o.id, type: 'CORPORATE', name: o.name,
          contact_info: o.contact_phone || o.contact_email || 'No contact',
          created_at: o.created_at, status: o.profile_status || 'LEAD',
          primaryIdentifier: o.registration_number,
        });
      }
    });
  };

  addCustomers(custFullRes.data);
  addCustomers(custQuickRes.data);
  addCustomers(custNotIntRes.data);
  
  addFamilies(famInProgressRes.data);
  addFamilies(famNewRes.data);

  addOrgs(orgInProgressRes.data);
  addOrgs(orgNewRes.data);

  // Sort by newest first
  unified.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  
  return unified;
};

export const updateLeadStatus = async (lead: UnifiedLead, newStatus: ProfileStatus) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  const entityBase = lead.type === 'INDIVIDUAL' ? 'customers' : lead.type === 'FAMILY' ? 'families' : 'organizations';
  const path = `/tenants/${tenantId}/${entityBase}/${lead.id}`;
  
  if (lead.type === 'INDIVIDUAL') {
    await api.put(path, { profile_status: newStatus });
  } else {
    await api.patch(path, { profile_status: newStatus });
  }
};

export const deleteLead = async (lead: UnifiedLead) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  const entityBase = lead.type === 'INDIVIDUAL' ? 'customers' : lead.type === 'FAMILY' ? 'families' : 'organizations';
  const path = `/tenants/${tenantId}/${entityBase}/${lead.id}`;
  
  await api.delete(path);
};

export const createIndividualLead = async (data: any) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
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
  } else {
    return api.post(`/tenants/${tenantId}/customers`, {
      cnic: data.cnic || null,
      first_name: data.firstName,
      last_name: data.lastName,
      dob: data.dob || null,
      gender: data.gender || "Male",
      occupation: data.occupation || null,
      declared_income: data.declaredIncome ? parseFloat(data.declaredIncome) : null,
      city: data.city || null,
      province: data.province || null,
      assigned_agent_id: data.assignedAgentId || agentId || null,
      branch_id: data.branch || null,
      details: { 
        marital_status: data.maritalStatus || "Single",
        nationality: data.nationality || "Pakistani",
        cnic_issue_date: data.cnicIssueDate || null,
        cnic_expiry_date: data.cnicExpiryDate || null,
        cnic_front_image: data.cnicFront || null,
        cnic_back_image: data.cnicBack || null,
        address: { 
          street: data.streetAddress || null,
          city: data.city || null, 
          province: data.province || null,
          postal_code: data.postalCode || null
        },
        contact: { 
          mobile_number: data.phone, 
          email: data.contactEmail || null,
          emergency_contact_name: data.emergencyContactName || null
        },
        employment: {
          employer_name: data.employerName || null,
          industry_sector: data.industrySector || null,
          years_of_experience: data.yearsOfExperience ? parseInt(data.yearsOfExperience, 10) : null
        },
        medical: {
          height_cm: data.height ? parseFloat(data.height) : null,
          weight_kg: data.weight ? parseFloat(data.weight) : null,
          exercise_frequency: data.exerciseFrequency || null
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
          moving_violations: data.movingViolations ? parseInt(data.movingViolations, 10) : null
        },
        financial: {
          credit_score: data.creditScore ? parseInt(data.creditScore, 10) : null
        },
        nominee: {
          first_name: data.beneficiaryFirstName || null,
          last_name: data.beneficiaryLastName || null,
          cnic: data.beneficiaryCnic || null,
          relationship: data.beneficiaryRelationship || null,
          share_percentage: data.beneficiaryShare ? parseFloat(data.beneficiaryShare) : null
        },
        insurance_plan_id: data.insurancePlanId || null
      }
    });
  }
};

export const createFamilyLead = async (data: any) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  if (data.leadCategory === 'quick') {
    return api.post(`/tenants/${tenantId}/families`, {
      name: data.name,
      contact_person: data.contactPerson || null,
      contact_phone: data.contactPhone || null,
    });
  } else {
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
  }
};

export const createCorporateLead = async (data: any) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  if (data.leadCategory === 'quick') {
    return api.post(`/tenants/${tenantId}/organizations`, {
      name: data.name,
      contact_person: data.contactPerson || null,
      contact_phone: data.contactPhone || null,
    });
  } else {
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
  }
};

export const fetchBranches = async (): Promise<Branch[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) return [];
  try {
    const res = await api.get(`/tenants/${tenantId}/branches`);
    return res.data;
  } catch (error) {
    console.error('Failed to fetch branches', error);
    return [];
  }
};

export const fetchAgents = async (): Promise<Agent[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) return [];
  try {
    const [rolesResp, usersResp] = await Promise.all([
      api.get("/roles"),
      api.get(`/tenants/${tenantId}/users/directory`),
    ]);
    const role = (rolesResp.data || []).find((r: any) => r.name === "Agent");
    if (!role) return [];
    return (usersResp.data || [])
      .filter((u: any) => u.role_id === role.id)
      .map((u: any) => ({ id: u.id, full_name: u.full_name, email: u.email }));
  } catch (error) {
    console.error('Failed to fetch agents', error);
    return [];
  }
};

export const fetchInsurancePlans = async (): Promise<InsurancePlan[]> => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  if (!tenantId) return [];
  try {
    const res = await api.get(`/tenants/${tenantId}/insurance-plans`);
    return res.data;
  } catch (error) {
    console.error('Failed to fetch insurance plans', error);
    return [];
  }
};
