import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { UnifiedLead } from '../api/leads';

interface LeadCardProps {
  lead: UnifiedLead;
  onStatusChange: (newStatus: 'PROSPECT' | 'NOT_INTERESTED' | 'LEAD') => void;
  onDelete?: () => void;
  onEdit?: () => void;
}

export default function LeadCard({ lead, onStatusChange, onDelete, onEdit }: LeadCardProps) {
  const isIndividual = lead.type === 'INDIVIDUAL';
  const isFamily = lead.type === 'FAMILY';
  
  const handleStatusUpdate = (status: 'PROSPECT' | 'NOT_INTERESTED' | 'LEAD') => {
    Alert.alert(
      'Confirm Action',
      `Are you sure you want to change status?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Confirm', onPress: () => onStatusChange(status) }
      ]
    );
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.typeBadgeContainer}>
          <View style={[styles.typeBadge, isIndividual ? styles.bgBlue : isFamily ? styles.bgSlate : styles.bgDarkSlate]}>
            <Text style={[styles.typeText, isIndividual ? styles.textBlue : isFamily ? styles.textSlate : styles.textDarkSlate]}>
              {lead.type.substring(0, 3)}
            </Text>
          </View>
          <Text style={styles.date}>{new Date(lead.created_at).toLocaleDateString()}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.statusBadge}>{lead.status.replace('_', ' ')}</Text>
          <TouchableOpacity onPress={() => Alert.alert('Lead Options', 'Select an action', [
            { text: 'Edit Lead', onPress: () => onEdit && onEdit() },
            { text: 'Delete', style: 'destructive', onPress: () => {
              Alert.alert('Confirm Delete', 'Are you sure you want to delete this lead?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => onDelete && onDelete() }
              ]);
            } },
            { text: 'Cancel', style: 'cancel' }
          ])}>
            <Ionicons name="ellipsis-vertical" size={18} color="#64748b" />
          </TouchableOpacity>
        </View>
      </View>
      
      <Text style={styles.name} numberOfLines={1}>{lead.name}</Text>
      <Text style={styles.contact} numberOfLines={1}>{lead.contact_info}</Text>
      {lead.primaryIdentifier ? <Text style={styles.contact}>{lead.primaryIdentifier}</Text> : null}

      <View style={styles.actions}>
        {lead.status === 'LEAD' && (
          <TouchableOpacity 
            style={[styles.btn, styles.btnPrimary]} 
            onPress={() => handleStatusUpdate('PROSPECT')}
          >
            <Text style={styles.btnTextPrimary}>In Progress</Text>
          </TouchableOpacity>
        )}
        
        {lead.status === 'NOT_INTERESTED' ? (
          <TouchableOpacity 
            style={[styles.btn, styles.btnOutline]} 
            onPress={() => handleStatusUpdate('LEAD')}
          >
            <Text style={styles.btnTextOutline}>Reactivate</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity 
            style={[styles.btn, styles.btnOutline]} 
            onPress={() => handleStatusUpdate('NOT_INTERESTED')}
          >
            <Text style={styles.btnTextOutline}>Dead</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    padding: 14,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  typeBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6,
  },
  typeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  bgBlue: { backgroundColor: '#dbeafe' },
  textBlue: { color: '#1d4ed8' },
  bgSlate: { backgroundColor: '#f1f5f9' },
  textSlate: { color: '#475569' },
  bgDarkSlate: { backgroundColor: '#e2e8f0' },
  textDarkSlate: { color: '#0f172a' },
  
  date: {
    fontSize: 10,
    color: '#94a3b8',
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: '#64748b',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 2,
  },
  contact: {
    fontSize: 12,
    color: '#475569',
  },
  actions: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 8,
  },
  btn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  btnPrimary: {
    backgroundColor: '#1d4ed8',
  },
  btnOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  btnTextPrimary: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  btnTextOutline: {
    color: '#64748b',
    fontSize: 12,
    fontWeight: '600',
  },
});
