import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Input from '../components/Input';
import Button from '../components/Button';
import { createIndividualLead, createFamilyLead, createCorporateLead, EntityType } from '../api/leads';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';

type AddLeadNavProp = NativeStackNavigationProp<RootStackParamList, 'AddLead'>;

export default function AddLeadScreen() {
  const [type, setType] = useState<EntityType>('INDIVIDUAL');
  const [loading, setLoading] = useState(false);
  
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [name, setName] = useState(''); // for Family and Corporate
  const [phone, setPhone] = useState('');
  const [cnic, setCnic] = useState('');
  const [regNumber, setRegNumber] = useState('');

  const navigation = useNavigation<AddLeadNavProp>();

  const handleTypeSelect = (selected: EntityType) => {
    setType(selected);
    // Reset forms
    setFirstName(''); setLastName(''); setName('');
    setPhone(''); setCnic(''); setRegNumber('');
  };

  const validate = () => {
    if (!phone) {
      Alert.alert('Error', 'Contact phone is required.');
      return false;
    }
    if (type === 'INDIVIDUAL' && (!firstName || !lastName)) {
      Alert.alert('Error', 'First and last name are required for individuals.');
      return false;
    }
    if ((type === 'FAMILY' || type === 'CORPORATE') && !name) {
      Alert.alert('Error', 'Name is required.');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    
    setLoading(true);
    try {
      if (type === 'INDIVIDUAL') {
        await createIndividualLead({ firstName, lastName, phone, cnic });
      } else if (type === 'FAMILY') {
        await createFamilyLead({ name, phone });
      } else if (type === 'CORPORATE') {
        await createCorporateLead({ name, phone, registrationNumber: regNumber });
      }
      
      Alert.alert('Success', 'Lead created successfully.', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ]);
      
      // Reset forms
      setFirstName(''); setLastName(''); setName('');
      setPhone(''); setCnic(''); setRegNumber('');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create lead.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <KeyboardAvoidingView 
        style={{ flex: 1 }} 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Generate Lead</Text>
            <Text style={styles.subtitle}>Enter preliminary contact info</Text>
          </View>

          <View style={styles.typeSelector}>
            {(['INDIVIDUAL', 'FAMILY', 'CORPORATE'] as EntityType[]).map(t => (
              <Text 
                key={t}
                onPress={() => handleTypeSelect(t)} 
                style={[styles.typeBtn, type === t && styles.typeBtnActive]}
              >
                {t === 'INDIVIDUAL' ? 'Individual' : t === 'FAMILY' ? 'Family' : 'Corporate'}
              </Text>
            ))}
          </View>

          <View style={styles.formCard}>
            {type === 'INDIVIDUAL' ? (
              <>
                <Input label="First Name *" placeholder="Ali" value={firstName} onChangeText={setFirstName} />
                <Input label="Last Name *" placeholder="Khan" value={lastName} onChangeText={setLastName} />
                <Input label="CNIC (Optional)" placeholder="35201-XXXXXXX-X" value={cnic} onChangeText={setCnic} keyboardType="numeric" />
              </>
            ) : type === 'FAMILY' ? (
              <>
                <Input label="Family Name *" placeholder="The Khan Family" value={name} onChangeText={setName} />
              </>
            ) : (
              <>
                <Input label="Company Name *" placeholder="Acme Corp" value={name} onChangeText={setName} />
                <Input label="Registration Number (Optional)" placeholder="XX-12345" value={regNumber} onChangeText={setRegNumber} />
              </>
            )}

            <Input label="Contact Phone *" placeholder="0300 1234567" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          </View>

          <Button 
            title="Create Lead" 
            onPress={handleSave} 
            loading={loading}
            style={styles.saveBtn}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  container: {
    padding: 16,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
  },
  typeSelector: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
    padding: 4,
    marginBottom: 24,
  },
  typeBtn: {
    flex: 1,
    textAlign: 'center',
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    borderRadius: 6,
    overflow: 'hidden',
  },
  typeBtnActive: {
    backgroundColor: '#ffffff',
    color: '#0f172a',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  formCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 16,
    marginBottom: 24,
  },
  saveBtn: {
    marginTop: 8,
  }
});
