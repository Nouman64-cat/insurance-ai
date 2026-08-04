import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const login = async (email: string, password: string) => {
  const formData = new URLSearchParams();
  formData.append('username', email);
  formData.append('password', password);

  // According to FastAPI OAuth2 password bearer
  const tokenResponse = await api.post('/auth/token', formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const { access_token } = tokenResponse.data;

  // Fetch current user details with access_token
  const meResponse = await api.get('/auth/me', {
    headers: { Authorization: `Bearer ${access_token}` }
  });

  const user = meResponse.data;

  await AsyncStorage.multiSet([
    ['jwt_token', access_token],
    ['tenant_id', user.tenant_id || ''],
    ['user_email', user.email || ''],
    ['user_role', user.role_name || ''],
    ['agent_id', user.id || '']
  ]);

  return user;
};

export const logout = async () => {
  await AsyncStorage.multiRemove(['jwt_token', 'tenant_id', 'user_email', 'user_role', 'agent_id']);
};
