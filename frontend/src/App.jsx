import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Shell from './components/Shell';
import Dashboard from './pages/Dashboard';
import Connections from './pages/Connections';
import Pipelines from './pages/Pipelines';
import PipelineEditor from './pages/PipelineEditor';
import Jobs from './pages/Jobs';

function PrivateRoute({ children }) {
  return localStorage.getItem('lb_token') ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<PrivateRoute><Shell /></PrivateRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="connections" element={<Connections />} />
          <Route path="clusters" element={<Navigate to="/connections?tab=ch" replace />} />
          <Route path="pipelines" element={<Pipelines />} />
          <Route path="pipelines/new" element={<PipelineEditor />} />
          <Route path="pipelines/:id/edit" element={<PipelineEditor />} />
          <Route path="jobs" element={<Jobs />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
