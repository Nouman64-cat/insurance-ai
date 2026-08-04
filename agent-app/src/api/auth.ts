import api from './api';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const login = async (email: string, password: string) => {
  const formData = new URLSearchParams();
  formData.append('username', email);
  formData.append('password', password);

  // According to FastAPI OAuth2 password bearer
  const response = await api.post('/auth/token', formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  const { access_token } = response.data;
  
  // Save the token so the interceptor can use it for the next request
  await AsyncStorage.setItem('jwt_token', access_token);

  // Fetch user profile using the token
  const meResponse = await api.get('/auth/me');
  const user = meResponse.data;

  await AsyncStorage.multiSet([
    ['tenant_id', user.tenant_id],
    ['user_email', user.email],
    ['user_role', user.role_name || ''],
    ['agent_id', user.id || '']
  ]);
  
  return user;
};

export const logout = async () => {
  await AsyncStorage.multiRemove(['jwt_token', 'tenant_id', 'user_email', 'user_role', 'agent_id']);
};
