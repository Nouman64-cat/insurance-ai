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

export const createIndividualLead = async (data: any) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  return api.post(`/tenants/${tenantId}/customers`, {
    first_name: data.firstName,
    last_name: data.lastName,
    cnic: data.cnic || null,
    assigned_agent_id: agentId || null,
    details: { contact: { mobile_number: data.phone, email: '' } }
  });
};

export const createFamilyLead = async (data: any) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  return api.post(`/tenants/${tenantId}/families`, {
    name: data.name,
    contact_phone: data.phone,
    assigned_agent_id: agentId || null,
  });
};

export const createCorporateLead = async (data: any) => {
  const tenantId = await AsyncStorage.getItem('tenant_id');
  const agentId = await AsyncStorage.getItem('agent_id');
  if (!tenantId) throw new Error('No tenant ID found');
  
  return api.post(`/tenants/${tenantId}/organizations`, {
    name: data.name,
    registration_number: data.registrationNumber || null,
    contact_phone: data.phone,
    assigned_agent_id: agentId || null,
  });
};
