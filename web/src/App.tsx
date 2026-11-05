import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './auth/AuthGate';
import { Layout } from './components/Layout';
import { ClientCard } from './pages/ClientCard';
import { Clients } from './pages/Clients';
import { Contacts } from './pages/Contacts';
import { Completeness } from './pages/Completeness';
import { Stats } from './pages/Stats';
import { Dashboard } from './pages/Dashboard';
import { Intake } from './pages/Intake';
import { IntakeBatch } from './pages/IntakeBatch';
import { Leases } from './pages/Leases';
import { LeaseCard } from './pages/LeaseCard';
import { Properties } from './pages/Properties';
import { PropertyCard } from './pages/PropertyCard';
import { DropboxCallback } from './pages/DropboxCallback';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';

export function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="properties" element={<Properties />} />
            <Route path="properties/:id" element={<PropertyCard />} />
            <Route path="clients" element={<Clients />} />
            <Route path="clients/:id" element={<ClientCard />} />
            <Route path="contacts" element={<Contacts />} />
            <Route path="contacts/:id" element={<ClientCard />} />
            <Route path="completeness" element={<Completeness />} />
            <Route path="stats" element={<Stats />} />
            <Route path="leases" element={<Leases />} />
            <Route path="leases/:id" element={<LeaseCard />} />
            <Route path="intake" element={<Intake />} />
            <Route path="intake/:id" element={<IntakeBatch />} />
            <Route path="settings" element={<Settings />} />
            <Route path="users" element={<Users />} />
            <Route path="dropbox" element={<DropboxCallback />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  );
}
