import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, FlatList, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/ThemeContext';

export interface Option {
  label: string;
  value: string;
  info?: string;
}

interface SelectInputProps {
  label: string;
  value: string;
  options: Option[];
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function SelectInput({ label, value, options, onSelect, placeholder = 'Select...', disabled = false }: SelectInputProps) {
  const [modalVisible, setModalVisible] = useState(false);
  const { colors, isDark } = useTheme();

  const selectedOption = options.find(o => o.value === value);
  const displayValue = selectedOption ? selectedOption.label : placeholder;

  return (
    <View style={styles.container}>
      <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
      <TouchableOpacity 
        style={[
          styles.input, 
          { backgroundColor: isDark ? colors.surface : '#f8fafc', borderColor: colors.border },
          disabled && { opacity: 0.6, backgroundColor: isDark ? '#1e293b' : '#f1f5f9' }
        ]} 
        onPress={() => !disabled && setModalVisible(true)}
        activeOpacity={0.7}
      >
        <Text style={[styles.inputText, { color: colors.text }, !selectedOption && { color: colors.textMuted }]}>
          {displayValue}
        </Text>
        <Ionicons name="chevron-down" size={20} color={colors.textMuted} />
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
            <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Select {label}</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <FlatList
              data={options}
              keyExtractor={(item) => item.value}
              renderItem={({ item }) => (
                <View style={[styles.optionItem, { borderBottomColor: colors.background }, item.value === value && { backgroundColor: isDark ? colors.border : '#eff6ff' }]}>
                  <TouchableOpacity
                    style={{ flex: 1 }}
                    onPress={() => {
                      onSelect(item.value);
                      setModalVisible(false);
                    }}
                  >
                    <Text style={[styles.optionText, { color: colors.text }, item.value === value && { color: colors.primary, fontWeight: '700' }]}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                  
                  <View style={styles.rightAccessories}>
                    {item.info && (
                      <TouchableOpacity 
                        style={styles.infoBtn}
                        onPress={() => Alert.alert(item.label, item.info)}
                      >
                        <Ionicons name="eye-outline" size={20} color={colors.textMuted} />
                      </TouchableOpacity>
                    )}
                    {item.value === value && (
                      <Ionicons name="checkmark" size={20} color={colors.primary} />
                    )}
                  </View>
                </View>
              )}
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: colors.textMuted }]}>No options available</Text>
              }
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  inputText: {
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '70%',
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 24,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  optionItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#f8fafc',
  },
  optionItemSelected: {
    backgroundColor: '#eff6ff',
  },
  optionText: {
    fontSize: 16,
    color: '#1e293b',
  },
  optionTextSelected: {
    color: '#1d4ed8',
    fontWeight: '600',
  },
  emptyText: {
    textAlign: 'center',
    color: '#94a3b8',
    marginTop: 40,
    fontSize: 14,
  },
  rightAccessories: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  infoBtn: {
    padding: 4,
  }
});
