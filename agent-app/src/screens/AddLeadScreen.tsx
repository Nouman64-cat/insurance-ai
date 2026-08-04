import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Input from '../components/Input';
import Button from '../components/Button';
import Accordion from '../components/Accordion';
import InfoBanner from '../components/InfoBanner';
import CheckboxCard from '../components/CheckboxCard';
import SelectInput from '../components/SelectInput';
import { Ionicons } from '@expo/vector-icons';
import { createIndividualLead, createFamilyLead, createCorporateLead, EntityType, fetchBranches, fetchInsurancePlans, Branch, InsurancePlan } from '../api/leads';
import api from '../api/api';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { useTheme } from '../theme/ThemeContext';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/AppNavigator';

type AddLeadNavProp = NativeStackNavigationProp<RootStackParamList, 'AddLead'>;
type AddLeadRouteProp = RouteProp<RootStackParamList, 'AddLead'>;
type LeadCategory = 'quick' | 'normal';

const PROVINCES = [
  { label: 'Punjab', value: 'Punjab' },
  { label: 'Sindh', value: 'Sindh' },
  { label: 'Khyber Pakhtunkhwa', value: 'Khyber Pakhtunkhwa' },
  { label: 'Balochistan', value: 'Balochistan' },
  { label: 'Gilgit-Baltistan', value: 'Gilgit-Baltistan' },
  { label: 'Azad Jammu & Kashmir', value: 'Azad Jammu & Kashmir' },
  { label: 'Islamabad Capital Territory', value: 'Islamabad Capital Territory' },
];

export default function AddLeadScreen() {
  const route = useRoute<AddLeadRouteProp>();
  const [type, setType] = useState<EntityType>(route.params?.type || 'INDIVIDUAL');
  const [category, setCategory] = useState<LeadCategory>(route.params?.category || 'quick');


  const [loading, setLoading] = useState(false);
  
  // INDIVIDUAL
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [cnic, setCnic] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('Male');
  const [maritalStatus, setMaritalStatus] = useState('Single');
  const [nationality, setNationality] = useState('Pakistani');
  const [occupation, setOccupation] = useState('');
  const [declaredIncome, setDeclaredIncome] = useState('');

  // INDIVIDUAL Extended fields
  const [cnicIssueDate, setCnicIssueDate] = useState('');
  const [cnicExpiryDate, setCnicExpiryDate] = useState('');
  const [employerName, setEmployerName] = useState('');
  const [industrySector, setIndustrySector] = useState('');
  const [yearsOfExperience, setYearsOfExperience] = useState('');
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [exerciseFrequency, setExerciseFrequency] = useState('Sedentary');
  const [smokingStatus, setSmokingStatus] = useState('Non-smoker');
  const [alcoholConsumption, setAlcoholConsumption] = useState('None');
  const [creditScore, setCreditScore] = useState('');
  const [beneficiaryFirstName, setBeneficiaryFirstName] = useState('');
  const [beneficiaryLastName, setBeneficiaryLastName] = useState('');
  const [beneficiaryCnic, setBeneficiaryCnic] = useState('');
  const [beneficiaryRelationship, setBeneficiaryRelationship] = useState('Spouse');
  const [beneficiaryShare, setBeneficiaryShare] = useState('100');

  // FAMILY
  const [familyName, setFamilyName] = useState('');
  const [householdIncome, setHouseholdIncome] = useState('');

  // CORPORATE
  const [companyName, setCompanyName] = useState('');
  const [regNumber, setRegNumber] = useState('');
  const [industry, setIndustry] = useState('');

  // Shared (Family & Corporate)
  const [contactPerson, setContactPerson] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  
  // New Missing Location & Contact Fields
  const [streetAddress, setStreetAddress] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [emergencyContactName, setEmergencyContactName] = useState('');

  // Habit check variables
  const [travelDestinations, setTravelDestinations] = useState('');
  const [movingViolations, setMovingViolations] = useState('');
  const [extremeSports, setExtremeSports] = useState('');
  const [recreationalDrugUse, setRecreationalDrugUse] = useState(false);
  const [participatesExtremeSports, setParticipatesExtremeSports] = useState(false);
  const [privateAviation, setPrivateAviation] = useState(false);
  const [frequentHighRiskTravel, setFrequentHighRiskTravel] = useState(false);

  // CNIC Images
  const [cnicFront, setCnicFront] = useState('');
  const [cnicBack, setCnicBack] = useState('');

  const [city, setCity] = useState('');
  const [province, setProvince] = useState('');
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [agentName, setAgentName] = useState('');
  
  const [insurancePlanId, setInsurancePlanId] = useState('');
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const { colors, isDark } = useTheme();

  const navigation = useNavigation<AddLeadNavProp>();

  useEffect(() => {
    fetchBranches().then(data => setBranches(data)).catch(() => {});
    fetchInsurancePlans().then(data => setPlans(data)).catch(() => {});
    
    // Attempt to load agent name from local storage, fallback to API if missing
    AsyncStorage.getItem('agent_name').then(name => {
      if (name) {
        setAgentName(name);
      } else {
        api.get('/auth/me').then(res => {
          if (res.data?.full_name) {
            setAgentName(res.data.full_name);
            AsyncStorage.setItem('agent_name', res.data.full_name);
          }
        }).catch(() => {});
      }
    });
  }, []);

  const handleTypeSelect = (selected: EntityType) => {
    setType(selected);
    resetForms();
  };

  const resetForms = () => {
    setFirstName(''); setLastName(''); setPhone('');
    setCnic(''); setDob(''); setGender('Male'); setMaritalStatus('Single');
    setNationality('Pakistani'); setOccupation(''); setDeclaredIncome('');
    
    setCnicIssueDate(''); setCnicExpiryDate('');
    setEmployerName(''); setIndustrySector(''); setYearsOfExperience('');
    setHeight(''); setWeight(''); setExerciseFrequency('Sedentary');
    setSmokingStatus('Non-smoker'); setAlcoholConsumption('None');
    setCreditScore('');
    setBeneficiaryFirstName(''); setBeneficiaryLastName(''); setBeneficiaryCnic('');
    setBeneficiaryRelationship('Spouse'); setBeneficiaryShare('100');

    setFamilyName(''); setHouseholdIncome('');
    
    setCompanyName(''); setRegNumber(''); setIndustry('');
    
    setContactPerson(''); setContactPhone(''); setContactEmail('');
    setCity(''); setProvince('');
    setStreetAddress(''); setPostalCode(''); setEmergencyContactName('');
    setTravelDestinations(''); setMovingViolations(''); setExtremeSports('');
    setRecreationalDrugUse(false); setParticipatesExtremeSports(false);
    setPrivateAviation(false); setFrequentHighRiskTravel(false);
    setCnicFront(''); setCnicBack('');
    setBranch('');
    setInsurancePlanId('');
  };

  const validate = () => {
    if (type === 'INDIVIDUAL') {
      if (!firstName.trim()) { Alert.alert('Error', 'First Name is required.'); return false; }
    } else if (type === 'FAMILY') {
      if (!familyName.trim()) { Alert.alert('Error', 'Family Name is required.'); return false; }
    } else if (type === 'CORPORATE') {
      if (!companyName.trim()) { Alert.alert('Error', 'Company Name is required.'); return false; }
    }
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;
    
    setLoading(true);
    try {
      if (type === 'INDIVIDUAL') {
        await createIndividualLead({
          leadCategory: category,
          firstName, lastName, phone, cnic, dob, gender, maritalStatus, nationality, occupation, declaredIncome, city, province, contactEmail,
          cnicIssueDate, cnicExpiryDate, employerName, industrySector, yearsOfExperience,
          height, weight, exerciseFrequency, smokingStatus, alcoholConsumption,
          creditScore, beneficiaryFirstName, beneficiaryLastName, beneficiaryCnic, beneficiaryRelationship, beneficiaryShare,
          streetAddress, postalCode, emergencyContactName, travelDestinations, movingViolations, extremeSports,
          cnicFront, cnicBack, recreationalDrugUse, participatesExtremeSports, privateAviation, frequentHighRiskTravel, branch, insurancePlanId
        });
      } else if (type === 'FAMILY') {
        await createFamilyLead({
          leadCategory: category,
          name: familyName, contactPerson, contactPhone, contactEmail, householdIncome, city, province, branch
        });
      } else if (type === 'CORPORATE') {
        await createCorporateLead({
          leadCategory: category,
          name: companyName, regNumber, industry, contactPerson, contactPhone, contactEmail, city, province, branch
        });
      }
      
      Alert.alert('Success', 'Lead created successfully.', [
        { text: 'OK', onPress: () => navigation.goBack() }
      ]);
      
      resetForms();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to create lead.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]} edges={['top']}>
      <KeyboardAvoidingView 
        style={{ flex: 1 }} 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>Generate Lead</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>Enter preliminary contact info</Text>
          </View>

          {/* Lead Category Toggle */}
          <View style={[styles.toggleContainer, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TouchableOpacity 
              style={[styles.toggleBtn, category === 'quick' && [styles.toggleBtnActive, { backgroundColor: colors.primary }]]}
              onPress={() => setCategory('quick')}
            >
              <Text style={[styles.toggleBtnText, { color: colors.textMuted }, category === 'quick' && styles.toggleBtnTextActive]}>
                Quick Lead
              </Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.toggleBtn, category === 'normal' && [styles.toggleBtnActive, { backgroundColor: colors.primary }]]}
              onPress={() => setCategory('normal')}
            >
              <Text style={[styles.toggleBtnText, { color: colors.textMuted }, category === 'normal' && styles.toggleBtnTextActive]}>
                Normal Lead
              </Text>
            </TouchableOpacity>
          </View>

            {type === 'INDIVIDUAL' && category === 'quick' && (
              <View style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Input label="First Name *" placeholder="Ali" value={firstName} onChangeText={setFirstName} />
                <Input label="Last Name" placeholder="Khan" value={lastName} onChangeText={setLastName} />
                <Input label="Phone Number" placeholder="0300 1234567" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
              </View>
            )}

            {type === 'INDIVIDUAL' && category === 'normal' && (
              <>
                <Accordion title="Identity & Contact" defaultExpanded>
                  <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>CORE IDENTITY PARAMETERS</Text>
                  <Input label="First Name *" placeholder="Ali" value={firstName} onChangeText={setFirstName} />
                  <Input label="Last Name *" placeholder="Khan" value={lastName} onChangeText={setLastName} />
                  <Input label="Date of Birth *" placeholder="YYYY-MM-DD" value={dob} onChangeText={setDob} />
                  <Input label="Gender *" placeholder="Male / Female" value={gender} onChangeText={setGender} />
                  <Input label="Marital Status" placeholder="Single / Married" value={maritalStatus} onChangeText={setMaritalStatus} />
                  <Input label="Nationality" placeholder="Pakistani" value={nationality} onChangeText={setNationality} />
                  
                  <Text style={[styles.sectionHeader, { color: colors.textMuted, marginTop: 24 }]}>CONTACT DETAILS</Text>
                  <Input label="Mobile Number" placeholder="0300 1234567" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
                  <Input label="Email Address" placeholder="example@email.com" value={contactEmail} onChangeText={setContactEmail} keyboardType="email-address" autoCapitalize="none" />
                  <Input label="Emergency Contact Name" placeholder="Ayesha Khan" value={emergencyContactName} onChangeText={setEmergencyContactName} />
                  
                  <Text style={[styles.sectionHeader, { color: colors.textMuted, marginTop: 24 }]}>ADDRESS INFORMATION</Text>
                  <Input label="Street Address" placeholder="123 Main St" value={streetAddress} onChangeText={setStreetAddress} />
                  <Input label="City" placeholder="Lahore" value={city} onChangeText={setCity} />
                  <SelectInput label="Province" placeholder="Select province" value={province} onSelect={setProvince} options={PROVINCES} />
                  <Input label="Postal Code" placeholder="54000" value={postalCode} onChangeText={setPostalCode} />
                  
                  <Text style={[styles.sectionHeader, { color: colors.textMuted, marginTop: 24 }]}>ADMINISTRATIVE</Text>
                  <SelectInput label="Branch" placeholder="Select branch" value={branch} onSelect={setBranch} options={branches.map(b => ({ label: b.name, value: b.id }))} />
                  <Input label="Assigned Agent" value={agentName} editable={false} placeholder="Loading..." />
                </Accordion>

                <Accordion title="CNIC & Docs">
                  <Text style={[styles.sectionHeader, { color: colors.textMuted }]}>CNIC DOCUMENTS</Text>
                  <Input label="CNIC (Optional for Lead)" placeholder="35201-XXXXXXX-X" value={cnic} onChangeText={setCnic} keyboardType="numeric" />
                  <Input label="CNIC Issue Date" placeholder="YYYY-MM-DD" value={cnicIssueDate} onChangeText={setCnicIssueDate} />
                  <Input label="CNIC Expiry Date" placeholder="YYYY-MM-DD" value={cnicExpiryDate} onChangeText={setCnicExpiryDate} />
                  
                  <Text style={[styles.sectionHeader, { color: colors.textMuted, marginTop: 24 }]}>CNIC IMAGES (OPTIONAL)</Text>
                  <View style={styles.imageUploadRow}>
                    <TouchableOpacity style={[styles.imageUploadBtn, { backgroundColor: isDark ? colors.background : '#f8fafc', borderColor: colors.border }]} onPress={() => Alert.alert('Upload', 'CNIC Front upload UI')}>
                      <Ionicons name="camera-outline" size={24} color={colors.textMuted} />
                      <Text style={[styles.imageUploadText, { color: colors.textMuted }]}>Front Side</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.imageUploadBtn, { backgroundColor: isDark ? colors.background : '#f8fafc', borderColor: colors.border }]} onPress={() => Alert.alert('Upload', 'CNIC Back upload UI')}>
                      <Ionicons name="camera-outline" size={24} color={colors.textMuted} />
                      <Text style={[styles.imageUploadText, { color: colors.textMuted }]}>Back Side</Text>
                    </TouchableOpacity>
                  </View>
                </Accordion>

                <Accordion title="Occupation & Income">
                  <Text style={styles.sectionHeader}>OCCUPATION DETAILS</Text>
                  <Input label="Occupation *" placeholder="Engineer" value={occupation} onChangeText={setOccupation} />
                  <Input label="Employer Name" placeholder="TechCorp" value={employerName} onChangeText={setEmployerName} />
                  <Input label="Industry Sector" placeholder="IT" value={industrySector} onChangeText={setIndustrySector} />
                  <Input label="Years of Experience" placeholder="5" value={yearsOfExperience} onChangeText={setYearsOfExperience} keyboardType="numeric" />
                  
                  <Text style={[styles.sectionHeader, { marginTop: 24 }]}>INCOME PROFILE</Text>
                  <Input label="Declared Annual Income (PKR) *" placeholder="1000000" value={declaredIncome} onChangeText={setDeclaredIncome} keyboardType="numeric" />
                </Accordion>

                <Accordion title="Medical & Lifestyle">
                  <Text style={styles.sectionHeader}>MEDICAL & BODY METRICS</Text>
                  <Input label="Height (cm)" placeholder="175" value={height} onChangeText={setHeight} keyboardType="numeric" />
                  <Input label="Weight (kg)" placeholder="70" value={weight} onChangeText={setWeight} keyboardType="numeric" />
                  
                  <Text style={[styles.sectionHeader, { marginTop: 24 }]}>LIFESTYLE</Text>
                  <Input label="Exercise Frequency" placeholder="Sedentary / Active" value={exerciseFrequency} onChangeText={setExerciseFrequency} />
                </Accordion>

                <Accordion title="Habit Check">
                  <InfoBanner 
                    title="Substance Consumption" 
                    subtitle="Critical fields for mortality pricing & risk assessment." 
                    icon="warning" 
                    color="#ef4444" 
                    bgColor="#fef2f2" 
                  />
                  <Input label="Smoking Status" placeholder="Non-smoker / Smoker" value={smokingStatus} onChangeText={setSmokingStatus} />
                  <Input label="Alcohol Consumption Frequency" placeholder="None / Frequent" value={alcoholConsumption} onChangeText={setAlcoholConsumption} />
                  <CheckboxCard 
                    title="Recreational Drug Use History (Past 3-5 Years)"
                    subtitle="Check if the customer has used illegal or non-prescribed substances."
                    checked={recreationalDrugUse}
                    onPress={() => setRecreationalDrugUse(!recreationalDrugUse)}
                  />

                  <View style={{ height: 24 }} />

                  <InfoBanner 
                    title="High-Risk Hobbies (Avocations)" 
                    subtitle="Identifies activities with high fatality rates." 
                    icon="flash" 
                    color="#f59e0b" 
                    bgColor="#fef3c7" 
                  />
                  <CheckboxCard 
                    title="Participates in Extreme Sports"
                    subtitle="Trigger flag for adventure/high-risk sports."
                    checked={participatesExtremeSports}
                    onPress={() => setParticipatesExtremeSports(!participatesExtremeSports)}
                  />
                  <CheckboxCard 
                    title="Private Aviation"
                    subtitle="Flies private aircraft or experimental planes (commercial passengers exempt)."
                    checked={privateAviation}
                    onPress={() => setPrivateAviation(!privateAviation)}
                  />
                  <Input label="Extreme Sports Details (If applicable)" placeholder="Skydiving, Scuba etc." value={extremeSports} onChangeText={setExtremeSports} />

                  <View style={{ height: 24 }} />

                  <InfoBanner 
                    title="Travel & Location Risks" 
                    subtitle="Underwriting travel to politically unstable or disease outbreak zones." 
                    icon="airplane" 
                    color="#3b82f6" 
                    bgColor="#eff6ff" 
                  />
                  <CheckboxCard 
                    title="Frequent High-Risk Travel"
                    subtitle="Travel planned or taken to politically unstable regions, active war zones, or severe outbreak areas."
                    checked={frequentHighRiskTravel}
                    onPress={() => setFrequentHighRiskTravel(!frequentHighRiskTravel)}
                  />
                  <Input label="Travel Destinations (Past/Next 12 Months)" placeholder="e.g. Dubai, London" value={travelDestinations} onChangeText={setTravelDestinations} />
                  <Input label="Moving Violations (Past 3 Years)" placeholder="0" value={movingViolations} onChangeText={setMovingViolations} keyboardType="numeric" />
                </Accordion>

                <Accordion title="Financial Profile">
                  <Text style={styles.sectionHeader}>CREDIT BUREAU INFO</Text>
                  <Input label="Credit Score" placeholder="750" value={creditScore} onChangeText={setCreditScore} keyboardType="numeric" />
                </Accordion>

                <Accordion title="Nominee Details">
                  <Text style={styles.sectionHeader}>PRIMARY BENEFICIARY</Text>
                  <Input label="First Name" placeholder="Ayesha" value={beneficiaryFirstName} onChangeText={setBeneficiaryFirstName} />
                  <Input label="Last Name" placeholder="Khan" value={beneficiaryLastName} onChangeText={setBeneficiaryLastName} />
                  <Input label="CNIC Number" placeholder="35201-XXXXXXX-X" value={beneficiaryCnic} onChangeText={setBeneficiaryCnic} keyboardType="numeric" />
                  <Input label="Relationship" placeholder="Spouse" value={beneficiaryRelationship} onChangeText={setBeneficiaryRelationship} />
                  <Input label="Share Percentage (%)" placeholder="100" value={beneficiaryShare} onChangeText={setBeneficiaryShare} keyboardType="numeric" />
                </Accordion>

                <Accordion title="Insurance Plans">
                  <SelectInput 
                    label="Select Plan" 
                    placeholder="Choose a plan" 
                    value={insurancePlanId} 
                    onSelect={setInsurancePlanId} 
                    options={plans.map(p => ({ label: p.label, value: p.id, info: p.description }))} 
                  />
                </Accordion>
              </>
            )}

            {type === 'FAMILY' && (
              <View style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Input label="Family Name *" placeholder="e.g. Rehman Family" value={familyName} onChangeText={setFamilyName} />
                <Input label="Contact Person (Proposer)" placeholder="e.g. Asad Rehman" value={contactPerson} onChangeText={setContactPerson} />
                <Input label="Contact Email" placeholder="family@example.com" value={contactEmail} onChangeText={setContactEmail} keyboardType="email-address" autoCapitalize="none" />
                <Input label="Contact Phone" placeholder="+92 300 1234567" value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad" />
                
                {category === 'normal' && (
                  <>
                    <Input 
                      label="Household Annual Income (PKR)" 
                      placeholder="2400000" 
                      value={householdIncome} 
                      onChangeText={setHouseholdIncome} 
                      keyboardType="numeric" 
                      helperText="Used for the floater's income-eligibility check — children and non-earning members don't have their own income."
                    />
                    <Input label="City" placeholder="e.g. Lahore" value={city} onChangeText={setCity} />
                    <SelectInput label="Province" placeholder="Select province" value={province} onSelect={setProvince} options={PROVINCES} />
                    <SelectInput label="Branch" placeholder="Select branch" value={branch} onSelect={setBranch} options={branches.map(b => ({ label: b.name, value: b.id }))} />
                    <Input label="Assigned Agent" value={agentName} editable={false} placeholder="Loading..." />
                  </>
                )}
              </View>
            )}

            {type === 'CORPORATE' && (
              <View style={[styles.formCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Input label="Company Name *" placeholder="TechPak Solutions" value={companyName} onChangeText={setCompanyName} />
                <Input label="Contact Person" placeholder="Ali Raza (HR)" value={contactPerson} onChangeText={setContactPerson} />
                <Input label="Contact Phone" placeholder="0300 1234567" value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad" />
                
                {category === 'normal' && (
                  <>
                    <Input label="Registration Number" placeholder="XX-12345" value={regNumber} onChangeText={setRegNumber} />
                    <Input label="Industry" placeholder="Software Development" value={industry} onChangeText={setIndustry} />
                    <Input label="Contact Email" placeholder="hr@company.com" value={contactEmail} onChangeText={setContactEmail} keyboardType="email-address" autoCapitalize="none" />
                    <Input label="City" placeholder="Lahore" value={city} onChangeText={setCity} />
                    <SelectInput label="Province" placeholder="Select province" value={province} onSelect={setProvince} options={PROVINCES} />
                    <SelectInput label="Branch" placeholder="Select branch" value={branch} onSelect={setBranch} options={branches.map(b => ({ label: b.name, value: b.id }))} />
                    <Input label="Assigned Agent" value={agentName} editable={false} placeholder="Loading..." />
                  </>
                )}
              </View>
            )}

          <Button 
            title={`Create ${category === 'quick' ? 'Quick' : 'Normal'} Lead`} 
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
    paddingBottom: 64,
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
  toggleContainer: {
    flexDirection: 'row',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    padding: 4,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  toggleBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleBtnActive: {
    backgroundColor: '#1D4ED8',
  },
  toggleBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  toggleBtnTextActive: {
    color: '#ffffff',
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
  typeBtnActive: {},
  formCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 24,
  },
  saveBtn: {
    marginTop: 8,
  },
  sectionHeader: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 16,
    marginTop: 8,
  },
  imageUploadRow: {
    flexDirection: 'row',
    gap: 12,
  },
  imageUploadBtn: {
    flex: 1,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    paddingVertical: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageUploadText: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
  }
});
